#!/usr/bin/env bash
# Reproducible deploy with the plain aws CLI. No SAM, no CDK.
# Usage: ./deploy.sh backend | frontend | all
# Needs: aws CLI authenticated to account 854924711083, node 22, and ../../.env (sandbox PayPal credentials).
set -euo pipefail
cd "$(dirname "$0")"
REGION=us-east-1; ACCOUNT=854924711083
FN=holdfast-api; TABLE=holdfast; ROLE=holdfast-lambda; BUCKET=holdfast-site-$ACCOUNT
STATE=.deploy-state; mkdir -p $STATE
set -a; . ../../.env; set +a
: "${VAULT_TOKEN_ID:=$(cat $STATE/vault-token-id 2>/dev/null || true)}"
export VAULT_TOKEN_ID
export AWS_DEFAULT_REGION=$REGION AWS_PAGER=""

backend() {
  echo "== DynamoDB"
  aws dynamodb describe-table --table-name $TABLE >/dev/null 2>&1 || {
    aws dynamodb create-table --table-name $TABLE --attribute-definitions AttributeName=pk,AttributeType=S \
      --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST >/dev/null
    aws dynamodb wait table-exists --table-name $TABLE; }
  echo "== IAM role"
  aws iam get-role --role-name $ROLE >/dev/null 2>&1 || {
    aws iam create-role --role-name $ROLE --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    sleep 10; }
  aws iam put-role-policy --role-name $ROLE --policy-name holdfast --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
   {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:DeleteItem\",\"dynamodb:Scan\"],\"Resource\":\"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE\"},
   {\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:InvokeModelWithResponseStream\"],\"Resource\":\"*\"},
   {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"*\"}]}"
  echo "== package"
  rm -f $STATE/fn.zip; (cd backend && zip -q -j ../$STATE/fn.zip *.mjs package.json)
  ENVJSON=$(node -e 'const e=process.env;console.log(JSON.stringify({Variables:{PAYPAL_CLIENT_ID:e.PAYPAL_CLIENT_ID,PAYPAL_SECRET:e.PAYPAL_SECRET,PAYPAL_API:e.PAYPAL_API,TABLE:"holdfast",BEDROCK_MODEL:e.BEDROCK_MODEL,VAULT_TOKEN_ID:e.VAULT_TOKEN_ID||"",ADMIN_KEY:e.ADMIN_KEY||""}}))')
  if aws lambda get-function --function-name $FN >/dev/null 2>&1; then
    aws lambda update-function-code --function-name $FN --zip-file fileb://$STATE/fn.zip >/dev/null
    aws lambda wait function-updated --function-name $FN
    aws lambda update-function-configuration --function-name $FN --environment "$ENVJSON" --timeout 60 --memory-size 512 >/dev/null
  else
    aws lambda create-function --function-name $FN --runtime nodejs22.x --handler index.handler --role arn:aws:iam::$ACCOUNT:role/$ROLE \
      --zip-file fileb://$STATE/fn.zip --timeout 60 --memory-size 512 --environment "$ENVJSON" >/dev/null
  fi
  aws lambda wait function-updated --function-name $FN
  echo "== Function URL"
  if ! aws lambda get-function-url-config --function-name $FN >/dev/null 2>&1; then
    aws lambda create-function-url-config --function-name $FN --auth-type NONE \
      --cors '{"AllowOrigins":["*"],"AllowMethods":["GET","POST"],"AllowHeaders":["content-type"],"MaxAge":3600}' >/dev/null
    aws lambda add-permission --function-name $FN --statement-id url-public --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null
    aws lambda add-permission --function-name $FN --statement-id url-invoke --action lambda:InvokeFunction --principal "*" >/dev/null  # newer CLIs add --invoked-via-function-url; 2.27 lacks it, and since Oct 2025 the URL needs this InvokeFunction grant too
  fi
  aws lambda get-function-url-config --function-name $FN --query FunctionUrl --output text | tee $STATE/api-url
  echo "== daily reauthorization sweep (EventBridge)"
  aws events put-rule --name holdfast-sweep --schedule-expression "cron(0 12 * * ? *)" --state ENABLED >/dev/null
  aws lambda add-permission --function-name $FN --statement-id sweep-rule --action lambda:InvokeFunction --principal events.amazonaws.com \
    --source-arn arn:aws:events:$REGION:$ACCOUNT:rule/holdfast-sweep >/dev/null 2>&1 || true
  aws events put-targets --rule holdfast-sweep --targets "Id=1,Arn=arn:aws:lambda:$REGION:$ACCOUNT:function:$FN" >/dev/null
}

frontend() {
  API=$(cat $STATE/api-url)
  echo "== build"
  (cd frontend && npm ci --silent && VITE_API="${API%/}" npm run build)
  echo "== S3 + CloudFront"
  aws s3api head-bucket --bucket $BUCKET 2>/dev/null || aws s3api create-bucket --bucket $BUCKET >/dev/null
  aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  if [ ! -f $STATE/cf-id ]; then
    OAC=$(aws cloudfront create-origin-access-control --origin-access-control-config "Name=holdfast-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" --query OriginAccessControl.Id --output text)
    cat > $STATE/cf.json <<JSON
{"CallerReference":"holdfast-$(date +%s)","Comment":"holdfast","Enabled":true,"DefaultRootObject":"index.html","PriceClass":"PriceClass_100",
 "Origins":{"Quantity":1,"Items":[{"Id":"s3","DomainName":"$BUCKET.s3.$REGION.amazonaws.com","OriginAccessControlId":"$OAC","S3OriginConfig":{"OriginAccessIdentity":""}}]},
 "DefaultCacheBehavior":{"TargetOriginId":"s3","ViewerProtocolPolicy":"redirect-to-https","Compress":true,"CachePolicyId":"658327ea-f89d-4fab-a63d-7e88639e58f6",
  "AllowedMethods":{"Quantity":2,"Items":["GET","HEAD"]}},
 "CustomErrorResponses":{"Quantity":1,"Items":[{"ErrorCode":403,"ResponsePagePath":"/index.html","ResponseCode":"200","ErrorCachingMinTTL":10}]}}
JSON
    aws cloudfront create-distribution --distribution-config file://$STATE/cf.json --query 'Distribution.[Id,DomainName]' --output text > $STATE/cf-info
    awk '{print $1}' $STATE/cf-info > $STATE/cf-id
  fi
  CF=$(cat $STATE/cf-id)
  aws s3api put-bucket-policy --bucket $BUCKET --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"cloudfront.amazonaws.com\"},\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\",\"Condition\":{\"StringEquals\":{\"AWS:SourceArn\":\"arn:aws:cloudfront::$ACCOUNT:distribution/$CF\"}}}]}"
  aws s3 sync frontend/dist s3://$BUCKET --delete --cache-control "public,max-age=300" --only-show-errors
  aws s3 cp frontend/dist/index.html s3://$BUCKET/index.html --cache-control "no-cache" --only-show-errors
  aws cloudfront create-invalidation --distribution-id $CF --paths '/*' >/dev/null
  echo "CloudFront: https://$(awk '{print $2}' $STATE/cf-info)"
}

case "${1:-all}" in backend) backend;; frontend) frontend;; all) backend; frontend;; esac
