// Demo data. Hospital, clinicians and patients are FICTIONAL. The price file imitates the shape of a
// hospital machine-readable price file (code, description, standard charge). The figures are an
// illustrative sample, not any real hospital's chargemaster; production would ingest the hospital's
// own published file.
export const HOSPITAL = { id: "sar", name: "St. Aldric Regional Medical Center", note: "fictional hospital" };

export const PRICES = [
  { code: "99285", desc: "Emergency department visit, high severity", unit: "visit", price: 2150 },
  { code: "00350", desc: "Anesthesia, major vessels of neck", unit: "case", price: 4800 },
  { code: "35701", desc: "Exploration of artery, neck, without repair", unit: "procedure", price: 14200 },
  { code: "35201", desc: "Direct repair of blood vessel, neck", unit: "procedure", price: 21900 },
  { code: "21470", desc: "Open treatment, complicated mandibular fracture, multiple approaches", unit: "procedure", price: 27400 },
  { code: "21462", desc: "Open treatment, mandibular fracture, with interdental fixation", unit: "procedure", price: 16800 },
  { code: "00192", desc: "Anesthesia, radical surgery of facial bones", unit: "case", price: 4300 },
  { code: "27506", desc: "Intramedullary nailing, femoral shaft fracture", unit: "procedure", price: 23800 },
  { code: "01230", desc: "Anesthesia, open procedure on upper leg bones", unit: "case", price: 3900 },
  { code: "OR-HR", desc: "Operating room time, per hour", unit: "hour", price: 5200 },
  { code: "ICU-DAY", desc: "Intensive care bed, per day", unit: "day", price: 7900 },
  { code: "ADM-DAY", desc: "Surgical ward bed, per day", unit: "day", price: 3100 },
  { code: "IMPL-FIX", desc: "Fixation plates and screws, implant set", unit: "set", price: 6100 },
  { code: "IMPL-NAIL", desc: "Intramedullary nail implant", unit: "set", price: 8800 },
  { code: "BLOOD-U", desc: "Blood product, per unit", unit: "unit", price: 640 },
];

export const SPONSORS = [
  { id: "fund-1", name: "Harbor Mutual Aid Fund", kind: "mutual-aid group", perCaseCap: 120000, pledge: 1000000, tokenEnv: "VAULT_TOKEN_ID" },
  // Used by the automated tests so they never touch the demo fund. Hidden from the UI config.
  { id: "fund-test", name: "Test Employer Relief Fund", kind: "employer", perCaseCap: 120000, pledge: 1000000, tokenEnv: "VAULT_TOKEN_ID", hidden: true },
];

export const SCENARIOS = [
  {
    id: "neck-bleed",
    title: "Bleeding neck hematoma, airway narrowing",
    specialty: "Vascular surgery",
    patient: "A.R., 58",
    presentation: "Arrives by ambulance with an expanding neck hematoma from an actively bleeding carotid injury; the airway is narrowing. The ED physician has documented the emergency condition and requested the on-call vascular surgeon for operative exploration and repair.",
    onCall: "Dr. M. Okafor, on-call vascular surgeon",
    onCallAccepts: true,
    acceptNote: "Accepts. Leaving home now, in the OR within 25 minutes.",
    procedure: [["99285", 1], ["00350", 1], ["35701", 1], ["35201", 1], ["OR-HR", 3], ["BLOOD-U", 4]],
    stay: [["ICU-DAY", 2]],
    procedureNote: "Neck exploration with direct carotid repair completed. Airway secured. Transferred to ICU.",
    outcome: "capture",
    promise: "Charged less than the guarantee",
    without: {
      figure: 100000, who: "Spartanburg Medical Center", when: "conduct May 2024, settled 12 November 2025",
      finding: "An actively bleeding carotid hematoma was narrowing the patient's airway. The on-call vascular surgeon would not come in.",
      note: "Surgeons were available.",
      source: "https://oig.hhs.gov/fraud/enforcement/",
    },
  },
  {
    id: "jaw",
    title: "Bilateral jaw fractures",
    specialty: "Oral and maxillofacial surgery",
    patient: "D.W., 31",
    presentation: "Arrives with bilateral mandible fractures after an assault. The ED physician has documented the emergency condition and requested the on-call oral and maxillofacial surgeon for open reduction and fixation.",
    onCall: "Dr. S. Lindqvist, on-call oral and maxillofacial surgeon",
    onCallAccepts: true,
    acceptNote: "Accepts. Booking the OR for first available slot tonight.",
    procedure: [["99285", 1], ["00192", 1], ["21470", 1], ["OR-HR", 4], ["IMPL-FIX", 1]],
    stay: [["ADM-DAY", 2]],
    procedureNote: "Open reduction and internal fixation of bilateral mandible fractures completed. Admitted to the surgical ward.",
    outcome: "capture",
    promise: "Captured in two parts as care was given",
    without: {
      figure: 150000, who: "Flowers Hospital, Dothan, Alabama", when: "conduct May 2021, settled 25 July 2025",
      finding: "The on-call oral and maxillofacial surgeon declined a patient with bilateral jaw fractures.",
      note: "Surgeons were available.",
      source: "https://oig.hhs.gov/fraud/enforcement/",
    },
  },
  {
    id: "transfer",
    title: "Femur fracture, patient transferred before incision",
    specialty: "Orthopaedic surgery",
    patient: "L.T., 44",
    presentation: "Arrives with an open femoral shaft fracture. The ED physician has documented the emergency condition and requested the on-call orthopaedic surgeon. Before incision, associated injuries lead the treating physicians to transfer the patient to a Level I trauma center that accepts the transfer.",
    onCall: "Dr. P. Anand, on-call orthopaedic surgeon",
    onCallAccepts: true,
    acceptNote: "Accepts. Preparing the OR while the transfer is confirmed.",
    procedure: [],
    stay: [],
    expected: [["99285", 1], ["01230", 1], ["27506", 1], ["IMPL-NAIL", 1], ["OR-HR", 3], ["ADM-DAY", 3]],
    procedureNote: "Procedure not performed. Patient transferred to a Level I trauma center by physician decision before incision.",
    outcome: "void",
    promise: "Nothing charged, hold released",
    without: null,
  },
];

// Typical resource use by specialty: the "procedure bundle" tool reads this. Ranges, not promises.
export const BUNDLES = {
  vascular: { match: /vascular|carotid|neck|artery/i, lines: [["99285", 1, 1], ["00350", 1, 1], ["35701", 1, 1], ["35201", 0, 1], ["OR-HR", 3, 5], ["BLOOD-U", 2, 8], ["ICU-DAY", 1, 3], ["ADM-DAY", 0, 2]] },
  omfs: { match: /maxillofacial|mandib|jaw|facial/i, lines: [["99285", 1, 1], ["00192", 1, 1], ["21462", 0, 1], ["21470", 0, 1], ["OR-HR", 3, 5], ["IMPL-FIX", 1, 2], ["ADM-DAY", 1, 3]] },
  ortho: { match: /orthop|femur|femoral|fracture/i, lines: [["99285", 1, 1], ["01230", 1, 1], ["27506", 1, 1], ["IMPL-NAIL", 1, 1], ["OR-HR", 2, 4], ["BLOOD-U", 0, 4], ["ADM-DAY", 2, 5]] },
};

// A deliberately messy hospital log for the reconstruction agent. Fictional. Out of order, one clinician
// contacted twice, one entry with no time, a long unlogged stretch, and a second-hand report.
export const MESSY_SAMPLE = [
  { id: "E7", source: "ED physician note", time: "2026-03-14T03:45:00-05:00", kind: "note", text: "Per Dr. Okafor on the phone, will not come in tonight. Arranging backup surgeon." },
  { id: "E1", source: "EHR triage", time: "2026-03-14T02:02:00-05:00", kind: "clinical", text: "Arrived by ambulance. Expanding neck swelling, voice changing. Airway narrowing noted." },
  { id: "E3", source: "Pager log", time: "2026-03-14T02:11:00-05:00", kind: "contact", person: "Dr. Okafor", direction: "outbound", text: "Page sent to on-call vascular surgeon. Delivered." },
  { id: "E2", source: "ED physician note", time: "2026-03-14T02:09:00-05:00", kind: "clinical", text: "Vascular surgery consult requested." },
  { id: "E4", source: "Phone log", time: "2026-03-14T02:14:00-05:00", kind: "contact", person: "Dr. Okafor", direction: "outbound", text: "Call placed. No answer." },
  { id: "E5", source: "Pager log", time: "2026-03-14T02:26:00-05:00", kind: "contact", person: "Dr. Okafor", direction: "outbound", text: "Page re-sent. Delivered." },
  { id: "E6", source: "Switchboard", time: "2026-03-14T03:40:00-05:00", kind: "contact", person: "Dr. Okafor", direction: "inbound", text: "Dr. Okafor returned call; connected to ED physician." },
  { id: "E8", source: "Nurse recollection, written later", time: null, kind: "note", text: "I think someone called the other surgeon around three? Not sure who." },
  { id: "E9", source: "OR board", time: "2026-03-14T03:52:00-05:00", kind: "clinical", text: "Patient to OR with Dr. Reyes (backup vascular)." },
];
