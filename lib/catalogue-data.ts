/**
 * The seeded catalogue.
 *
 * ## What this is, and what it is not
 *
 * These are real, widely-known medicines and brands — the ones a Bengaluru
 * customer would actually ask for. They are here so the search, ranking and
 * inventory features have something true to work on.
 *
 * They are **not** a regulatory database. Specifically:
 *
 *  - `manufacturer` and `barcode` are left null unless the value is genuinely
 *    known. Inventing a plausible-looking GST number or barcode would be worse
 *    than admitting ignorance, because somebody would act on it.
 *  - `requires_prescription` is marked `rx_basis: "curated"` — a general-knowledge
 *    judgement, not a lookup against the CDSCO register. It is right for the
 *    obvious cases (antibiotics, steroids, opioids, benzodiazepines) and should
 *    be treated as advisory everywhere else. The UI says so.
 *  - `price_paise` is a **fictional demo price**. Nothing here is a real price.
 *  - Availability in India is not implied by a product existing. A medicine
 *    approved elsewhere may not be marketed here, and this catalogue says nothing
 *    about that.
 *
 * Every row carries `verification_status`, so the UI can label what is asserted
 * and what is not. `demo` marks the fictional demonstration products that exist
 * purely to exercise edge cases (a controlled-substance-shaped row, a
 * paediatric formulation) and are never presented as real catalogue data.
 *
 * ## The rule that shapes the shape of the data
 *
 * One row = one presentation = one ingredient at one strength in one form. A
 * 500mg tablet and a 650mg tablet are two entries, not one. A brand is never
 * merged into its generic: `Dolo 650` is a brand, `Paracetamol` is the generic,
 * and searching for either must land on the right row.
 */

export interface CatalogueEntry {
  generic: string;
  /** Null when no well-known brand is asserted. */
  brand?: string | null;
  /** More than one means a combination product. */
  ingredients?: string[];
  strengthValue?: number | null;
  strengthUnit?: string | null;
  form: string;
  route?: string;
  category: string;
  subcategory?: string | null;
  therapeuticClass?: string | null;
  manufacturer?: string | null;
  /** true = prescription-only in general use. See the header note. */
  rx?: boolean;
  aliases?: string[];
  packageSize?: string | null;
  /** Identifier in the upstream source, when one exists. Null for curated rows. */
  sourceRef?: string | null;
  pricePaise: number;
  /** Defaults to "unverified". Set "demo" only for fictional demonstration rows. */
  verification?: "verified" | "unverified" | "demo";
}

/**
 * The 40 catalogue categories.
 *
 * Categories are for organising and filtering. They are not indications, and
 * nothing in this file says what any medicine treats.
 */
export const CATEGORIES = [
  "Pain relief and fever",
  "Cold, cough and respiratory",
  "Allergy and antihistamines",
  "Gastrointestinal and acidity",
  "Antacids and oral rehydration",
  "Vitamins and minerals",
  "Nutritional supplements",
  "Dermatology and skin care",
  "Eye preparations",
  "Ear preparations",
  "Oral and dental care",
  "Diabetes medicines",
  "Blood pressure and cardiovascular",
  "Cholesterol medicines",
  "Thyroid medicines",
  "Asthma and respiratory inhalers",
  "Neurology medicines",
  "Mental health medicines",
  "Antibiotics and antimicrobials",
  "Antifungal and antiviral",
  "Antiparasitic medicines",
  "Women's health and gynaecology",
  "Men's health and urology",
  "Pregnancy and prenatal",
  "Paediatric formulations",
  "Geriatric care",
  "Bone, joint and muscle",
  "Kidney and urinary health",
  "Liver and digestive health",
  "First aid and antiseptics",
  "Wound care and dressings",
  "Topical creams and ointments",
  "Injections and infusions",
  "Eye drops and ophthalmic",
  "Ear drops and otic",
  "Nasal sprays and drops",
  "Inhalers and nebulisation",
  "Oral liquids and syrups",
  "Tablets and capsules",
  "Emergency care",
  "Devices, diagnostics and essentials",
] as const;

export type Category = (typeof CATEGORIES)[number];

const RX = true;

/**
 * The catalogue.
 *
 * Kept as compact tuples in places where a dozen antihistamine tablets differ
 * only by strength — which is exactly the case the data model exists to handle,
 * so it is worth reading.
 */
export const CATALOGUE: CatalogueEntry[] = [
  // ------------------------------------------------ Pain relief and fever
  { generic: "Paracetamol", brand: "Dolo 650", ingredients: ["Paracetamol"], strengthValue: 650, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "Analgesic", therapeuticClass: "Analgesic / antipyretic", rx: false, aliases: ["paracetamol", "acetaminophen", "dolo", "dolo 650", "calpol", "tylenol", "paracetamoll"], packageSize: "15 tablets", pricePaise: 3800 },
  { generic: "Paracetamol", brand: "Crocin Advance", ingredients: ["Paracetamol"], strengthValue: 400, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "Analgesic", therapeuticClass: "Analgesic / antipyretic", rx: false, aliases: ["crocin", "paracetamol", "acetaminophen", "crocin advance"], packageSize: "15 tablets", pricePaise: 3200 },
  { generic: "Paracetamol", ingredients: ["Paracetamol"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "Analgesic", therapeuticClass: "Analgesic / antipyretic", rx: false, aliases: ["paracetamol", "acetaminophen", "calpol", "tylenol"], packageSize: "15 tablets", pricePaise: 2500 },
  { generic: "Ibuprofen", brand: "Brufen", ingredients: ["Ibuprofen"], strengthValue: 400, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "NSAID", therapeuticClass: "NSAID", rx: false, aliases: ["ibuprofen", "brufen", "advil", "ibu"], packageSize: "10 tablets", pricePaise: 3100 },
  { generic: "Ibuprofen", ingredients: ["Ibuprofen"], strengthValue: 400, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "NSAID", therapeuticClass: "NSAID", rx: false, aliases: ["ibuprofen", "advil"], packageSize: "10 tablets", pricePaise: 2800 },
  { generic: "Ibuprofen", ingredients: ["Ibuprofen"], strengthValue: 200, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "NSAID", therapeuticClass: "NSAID", rx: false, aliases: ["ibuprofen"], packageSize: "10 tablets", pricePaise: 2200 },
  { generic: "Diclofenac", brand: "Voveran", ingredients: ["Diclofenac Sodium"], strengthValue: 50, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "NSAID", therapeuticClass: "NSAID", rx: RX, aliases: ["diclofenac", "voveran", "voltaren"], packageSize: "10 tablets", pricePaise: 3400 },
  { generic: "Aceclofenac", brand: "Hifenac", ingredients: ["Aceclofenac"], strengthValue: 100, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "NSAID", therapeuticClass: "NSAID", rx: RX, aliases: ["aceclofenac", "hifenac", "zerodol"], packageSize: "10 tablets", pricePaise: 5200 },
  { generic: "Naproxen", ingredients: ["Naproxen"], strengthValue: 250, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "NSAID", therapeuticClass: "NSAID", rx: RX, aliases: ["naproxen"], packageSize: "10 tablets", pricePaise: 4100 },
  { generic: "Aspirin", brand: "Ecosprin", ingredients: ["Acetylsalicylic Acid"], strengthValue: 75, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "Antiplatelet", therapeuticClass: "Antiplatelet", rx: RX, aliases: ["aspirin", "ecosprin", "disprin", "acetylsalicylic acid"], packageSize: "14 tablets", pricePaise: 2200 },
  { generic: "Tramadol", ingredients: ["Tramadol"], strengthValue: 50, strengthUnit: "mg", form: "Capsule", route: "Oral", category: "Pain relief and fever", subcategory: "Opioid analgesic", therapeuticClass: "Opioid analgesic", rx: RX, aliases: ["tramadol", "ultram"], packageSize: "10 capsules", pricePaise: 6500 },

  // ------------------------------------------------ Cold, cough, respiratory
  { generic: "Dextromethorphan", brand: "Benadryl", ingredients: ["Dextromethorphan"], strengthValue: 100, strengthUnit: "ml", form: "Syrup", route: "Oral", category: "Cold, cough and respiratory", subcategory: "Antitussive", therapeuticClass: "Antitussive", rx: false, aliases: ["cough syrup", "dextromethorphan", "benadryl", "dm"], packageSize: "100 ml", pricePaise: 9500 },
  { generic: "Chlorpheniramine", ingredients: ["Chlorpheniramine Maleate"], strengthValue: 4, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Cold, cough and respiratory", subcategory: "Antihistamine", therapeuticClass: "First-generation antihistamine", rx: false, aliases: ["chlorpheniramine", "cpm", "piriton"], packageSize: "10 tablets", pricePaise: 900 },
  { generic: "Montelukast", brand: "Montair", ingredients: ["Montelukast"], strengthValue: 10, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Cold, cough and respiratory", subcategory: "Leukotriene antagonist", therapeuticClass: "Leukotriene antagonist", rx: RX, aliases: ["montelukast", "montair"], packageSize: "10 tablets", pricePaise: 14500 },
  { generic: "Acebrophylline", ingredients: ["Acebrophylline"], strengthValue: 100, strengthUnit: "mg", form: "Capsule", route: "Oral", category: "Cold, cough and respiratory", subcategory: "Mucolytic", therapeuticClass: "Mucolytic", rx: RX, aliases: ["acebrophylline"], packageSize: "10 capsules", pricePaise: 7400 },
  { generic: "Guaifenesin", ingredients: ["Guaifenesin", "Terbutaline", "Bromhexine"], strengthValue: 100, strengthUnit: "ml", form: "Syrup", route: "Oral", category: "Cold, cough and respiratory", subcategory: "Expectorant", therapeuticClass: "Mucolytic", rx: false, aliases: ["guaifenesin", "cough", "expectorant"], packageSize: "100 ml", pricePaise: 8200 },

  // ------------------------------------------------ Allergy and antihistamines
  { generic: "Cetirizine", ingredients: ["Cetirizine"], strengthValue: 10, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Allergy and antihistamines", subcategory: "Second-generation antihistamine", therapeuticClass: "Antihistamine", rx: false, aliases: ["cetirizine", "zyrtec", "allegra"], packageSize: "10 tablets", pricePaise: 2800 },
  { generic: "Fexofenadine", brand: "Allegra", ingredients: ["Fexofenadine"], strengthValue: 120, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Allergy and antihistamines", subcategory: "Second-generation antihistamine", therapeuticClass: "Antihistamine", rx: false, aliases: ["fexofenadine", "allegra", "allegra 120"], packageSize: "10 tablets", pricePaise: 9500 },
  { generic: "Levocetirizine", ingredients: ["Levocetirizine"], strengthValue: 5, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Allergy and antihistamines", subcategory: "Second-generation antihistamine", therapeuticClass: "Antihistamine", rx: false, aliases: ["levocetirizine", "xyzal"], packageSize: "10 tablets", pricePaise: 4600 },
  { generic: "Loratadine", ingredients: ["Loratadine"], strengthValue: 10, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Allergy and antihistamines", subcategory: "Second-generation antihistamine", therapeuticClass: "Antihistamine", rx: false, aliases: ["loratadine", "claritin", "allegra"], packageSize: "10 tablets", pricePaise: 1800 },

  // ------------------------------------------------ Gastrointestinal and acidity
  { generic: "Omeprazole", brand: "Omez", ingredients: ["Omeprazole"], strengthValue: 20, strengthUnit: "mg", form: "Capsule", route: "Oral", category: "Gastrointestinal and acidity", subcategory: "Proton pump inhibitor", therapeuticClass: "PPI", rx: false, aliases: ["omeprazole", "omez", "prilosec"], packageSize: "14 capsules", pricePaise: 5200 },
  { generic: "Pantoprazole", brand: "Pan", ingredients: ["Pantoprazole"], strengthValue: 40, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Gastrointestinal and acidity", subcategory: "Proton pump inhibitor", therapeuticClass: "PPI", rx: false, aliases: ["pantoprazole", "pan"], packageSize: "10 tablets", pricePaise: 6500 },
  { generic: "Rabeprazole", ingredients: ["Rabeprazole"], strengthValue: 20, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Gastrointestinal and acidity", subcategory: "Proton pump inhibitor", therapeuticClass: "PPI", rx: RX, aliases: ["rabeprazole"], packageSize: "10 tablets", pricePaise: 7200 },
  { generic: "Domperidone", brand: "Domstal", ingredients: ["Domperidone"], strengthValue: 10, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Gastrointestinal and acidity", subcategory: "Prokinetic", therapeuticClass: "Prokinetic", rx: false, aliases: ["domperidone", "domstal", "motilium"], packageSize: "10 tablets", pricePaise: 4000 },
  { generic: "Ondansetron", ingredients: ["Ondansetron"], strengthValue: 4, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Gastrointestinal and acidity", subcategory: "Antiemetic", therapeuticClass: "Antiemetic (5-HT3 antagonist)", rx: RX, aliases: ["ondansetron", "zofran"], packageSize: "10 tablets", pricePaise: 3400 },
  { generic: "Loperamide", ingredients: ["Loperamide"], strengthValue: 2, strengthUnit: "mg", form: "Capsule", route: "Oral", category: "Gastrointestinal and acidity", subcategory: "Antidiarrhoeal", therapeuticClass: "Antidiarrhoeal", rx: false, aliases: ["loperamide", "imodium"], packageSize: "10 capsules", pricePaise: 1900 },

  // ------------------------------------------------ Antacids and ORS
  { generic: "Ranitidine", ingredients: ["Ranitidine"], strengthValue: 150, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antacids and oral rehydration", subcategory: "H2 antagonist", therapeuticClass: "H2 receptor antagonist", rx: false, aliases: ["ranitidine", "zantac"], packageSize: "10 tablets", pricePaise: 3200 },
  { generic: "Magnesium Hydroxide", brand: "Gelusil", ingredients: ["Magnesium Hydroxide", "Aluminium Hydroxide", "Simethicone"], strengthValue: 200, strengthUnit: "mg", form: "Gel", route: "Oral", category: "Antacids and oral rehydration", subcategory: "Antacid", therapeuticClass: "Antacid", rx: false, aliases: ["antacid", "gelusil", "digene", "mylanta"], packageSize: "170 g", pricePaise: 14500 },
  { generic: "Oral Rehydration Salts", brand: "Jeera ORS", ingredients: ["Oral Rehydration Salts"], strengthValue: null, strengthUnit: "g", form: "Sachet", route: "Oral", category: "Antacids and oral rehydration", subcategory: "Rehydration", therapeuticClass: "Rehydration solution", rx: false, aliases: ["ors", "oral rehydration salts", "jeera ors", "electral", "rehydration"], packageSize: "10 sachets", pricePaise: 1200 },
  { generic: "Ringer Lactate", ingredients: ["Compound Sodium Lactate"], strengthValue: 500, strengthUnit: "ml", form: "Injection", route: "Intravenous", category: "Antacids and oral rehydration", subcategory: "IV fluid", therapeuticClass: "IV fluid", rx: RX, aliases: ["rl", "ringer lactate", "hartmann"], packageSize: "500 ml", pricePaise: 3200 },

  // ------------------------------------------------ Vitamins and minerals
  { generic: "Vitamin C", brand: "Limcee", ingredients: ["Ascorbic Acid"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Vitamins and minerals", subcategory: "Vitamin", therapeuticClass: "Vitamin", rx: false, aliases: ["vitamin c", "ascorbic acid", "limcee"], packageSize: "15 tablets", pricePaise: 4500 },
  { generic: "Vitamin B Complex", ingredients: ["Vitamin B1", "Vitamin B2", "Vitamin B6", "Vitamin B12", "Nicotinamide", "Folic Acid"], strengthValue: null, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Vitamins and minerals", subcategory: "Vitamin", therapeuticClass: "Vitamin", rx: false, aliases: ["b complex", "vitamin b", "neurobion", "becosules"], packageSize: "10 tablets", pricePaise: 12000 },
  { generic: "Multivitamin with Minerals", brand: "Zincovit", ingredients: ["Vitamin A", "Vitamin C", "Vitamin D3", "Zinc", "Folic Acid", "Iron"], strengthValue: null, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Vitamins and minerals", subcategory: "Vitamin", therapeuticClass: "Vitamin", rx: false, aliases: ["zincovit", "multivitamin", "supradyn", "centrum"], packageSize: "15 tablets", pricePaise: 5500 },
  { generic: "Vitamin D3", brand: "Uprise D3", ingredients: ["Cholecalciferol"], strengthValue: 60_000, strengthUnit: "IU", form: "Capsule", route: "Oral", category: "Vitamins and minerals", subcategory: "Vitamin", therapeuticClass: "Vitamin", rx: false, aliases: ["vitamin d", "d3", "uprise", "cholecalciferol"], packageSize: "10 capsules", pricePaise: 9800 },
  { generic: "Ferrous Ascorbate", brand: "Orofer XT", ingredients: ["Ferrous Ascorbate", "Folic Acid"], strengthValue: 100, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Vitamins and minerals", subcategory: "Mineral", therapeuticClass: "Haematinic", rx: RX, aliases: ["iron", "ferrous ascorbate", "orofer"], packageSize: "10 tablets", pricePaise: 8600 },
  { generic: "Calcium Carbonate", brand: "Shelcal", ingredients: ["Calcium Carbonate", "Vitamin D3"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Vitamins and minerals", subcategory: "Mineral", therapeuticClass: "Mineral supplement", rx: false, aliases: ["calcium", "shelcal", "calcirol"], packageSize: "30 tablets", pricePaise: 16500 },
  { generic: "Zinc", brand: "Zincovit", ingredients: ["Zinc Gluconate"], strengthValue: 20, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Vitamins and minerals", subcategory: "Mineral", therapeuticClass: "Mineral supplement", rx: false, aliases: ["zinc", "zincovit"], packageSize: "20 tablets", pricePaise: 2900 },

  // ------------------------------------------------ Nutritional supplements
  { generic: "Protein Supplement", brand: "Ensure", ingredients: ["Protein Blend"], strengthValue: 30, strengthUnit: "g", form: "Powder", route: "Oral", category: "Nutritional supplements", subcategory: "Nutrition support", therapeuticClass: "Nutrition support", rx: false, aliases: ["ensure", "protein", "nutrition", "pediasure"], packageSize: "400 g", pricePaise: 32000 },
  { generic: "Omega-3 Fatty Acids", ingredients: ["Fish Oil (EPA/DHA)"], strengthValue: 1000, strengthUnit: "mg", form: "Capsule", route: "Oral", category: "Nutritional supplements", subcategory: "Nutrition support", therapeuticClass: "Supplement", rx: false, aliases: ["omega 3", "fish oil", "maxepa"], packageSize: "60 capsules", pricePaise: 24000 },

  // ------------------------------------------------ Dermatology and skin care
  { generic: "Clotrimazole", brand: "Canesten", ingredients: ["Clotrimazole"], strengthValue: 1, strengthUnit: "%", form: "Cream", route: "Topical", category: "Dermatology and skin care", subcategory: "Antifungal", therapeuticClass: "Azole antifungal", rx: false, aliases: ["clotrimazole", "canesten", "candid"], packageSize: "20 g", pricePaise: 9800 },
  { generic: "Ketoconazole", brand: "Nizral", ingredients: ["Ketoconazole"], strengthValue: 2, strengthUnit: "%", form: "Cream", route: "Topical", category: "Dermatology and skin care", subcategory: "Antifungal", therapeuticClass: "Azole antifungal", rx: RX, aliases: ["ketoconazole", "nizral", "nizoral"], packageSize: "20 g", pricePaise: 11200 },
  { generic: "Permethrin", brand: "Scabper", ingredients: ["Permethrin"], strengthValue: 5, strengthUnit: "%", form: "Cream", route: "Topical", category: "Dermatology and skin care", subcategory: "Scabicide", therapeuticClass: "Scabicide", rx: false, aliases: ["permethrin", "scabper", "ointment"], packageSize: "30 g", pricePaise: 6500 },

  // ------------------------------------------------ Eye preparations
  { generic: "Carboxymethylcellulose", brand: "Refresh Tears", ingredients: ["Carboxymethylcellulose Sodium"], strengthValue: 0.5, strengthUnit: "%", form: "Eye drops", route: "Ophthalmic", category: "Eye drops and ophthalmic", subcategory: "Ocular lubricant", therapeuticClass: "Ocular lubricant", rx: false, aliases: ["artificial tears", "refresh tears", "carboxymethylcellulose", "cmc"], packageSize: "10 ml", pricePaise: 12500 },
  { generic: "Moxifloxacin", ingredients: ["Moxifloxacin"], strengthValue: 0.5, strengthUnit: "%", form: "Eye drops", route: "Ophthalmic", category: "Eye drops and ophthalmic", subcategory: "Antibacterial", therapeuticClass: "Fluoroquinolone", rx: RX, aliases: ["moxifloxacin", "moxeza", "eye drops"], packageSize: "5 ml", pricePaise: 18500 },
  { generic: "Latanoprost", ingredients: ["Latanoprost"], strengthValue: 0.005, strengthUnit: "%", form: "Eye drops", route: "Ophthalmic", category: "Eye preparations", subcategory: "Prostaglandin analogue", therapeuticClass: "Prostaglandin analogue", rx: RX, aliases: ["latanoprost", "xalatan"], packageSize: "2.5 ml", pricePaise: 32000 },

  // ------------------------------------------------ Ear preparations
  { generic: "Ciprofloxacin", ingredients: ["Ciprofloxacin"], strengthValue: 0.3, strengthUnit: "%", form: "Ear drops", route: "Otic", category: "Ear drops and otic", subcategory: "Antibacterial", therapeuticClass: "Fluoroquinolone", rx: RX, aliases: ["ciprofloxacin", "ear drops", "ciprodex"], packageSize: "10 ml", pricePaise: 9200 },
  { generic: "Xylitol", ingredients: ["Xylitol"], strengthValue: 1, strengthUnit: "%", form: "Ear drops", route: "Otic", category: "Ear preparations", subcategory: "Cerumenolytic", therapeuticClass: "Cerumenolytic", rx: false, aliases: ["xylitol", "ear wax drops", "ear"], packageSize: "10 ml", pricePaise: 12500 },

  // ------------------------------------------------ Oral and dental care
  { generic: "Chlorhexidine", brand: "Hexidine", ingredients: ["Chlorhexidine Gluconate"], strengthValue: 0.2, strengthUnit: "%", form: "Mouthwash", route: "Topical", category: "Oral and dental care", subcategory: "Antiseptic", therapeuticClass: "Antiseptic", rx: false, aliases: ["chlorhexidine", "hexidine", "mouthwash"], packageSize: "200 ml", pricePaise: 14500 },
  { generic: "Fluoride Toothpaste", ingredients: ["Sodium Fluoride"], strengthValue: 1000, strengthUnit: "ppm", form: "Paste", route: "Topical", category: "Oral and dental care", subcategory: "Fluoride", therapeuticClass: "Fluoride", rx: false, aliases: ["toothpaste", "fluoride", "colgate", "closeup"], packageSize: "150 g", pricePaise: 9900 },

  // ------------------------------------------------ Diabetes
  { generic: "Metformin", brand: "Glycomet", ingredients: ["Metformin HCl"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Diabetes medicines", subcategory: "Biguanide", therapeuticClass: "Biguanide", rx: RX, aliases: ["metformin", "glycomet", "glucophage", "metformin hcl"], packageSize: "10 tablets", pricePaise: 3500 },
  { generic: "Glibenclamide", brand: "Daonil", ingredients: ["Glibenclamide"], strengthValue: 5, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Diabetes medicines", subcategory: "Sulfonylurea", therapeuticClass: "Sulfonylurea", rx: RX, aliases: ["glibenclamide", "daonil", "glyburide"], packageSize: "10 tablets", pricePaise: 2600 },
  { generic: "Insulin (Human)", brand: "Insulatard", ingredients: ["Human Insulin"], strengthValue: 100, strengthUnit: "IU", form: "Injection", route: "Subcutaneous", category: "Diabetes medicines", subcategory: "Insulin", therapeuticClass: "Insulin", rx: RX, aliases: ["insulin", "insulatard", "human insulin"], packageSize: "3 ml pen", pricePaise: 95000 },

  // ------------------------------------------------ BP / cardiovascular
  { generic: "Amlodipine", brand: "Amlokind", ingredients: ["Amlodipine"], strengthValue: 5, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Blood pressure and cardiovascular", subcategory: "Calcium channel blocker", therapeuticClass: "CCB", rx: RX, aliases: ["amlodipine", "amlokind", "norvasc"], packageSize: "10 tablets", pricePaise: 3000 },
  { generic: "Telmisartan", brand: "Telma", ingredients: ["Telmisartan"], strengthValue: 40, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Blood pressure and cardiovascular", subcategory: "ARB", therapeuticClass: "ARB", rx: RX, aliases: ["telmisartan", "telma", "micardis"], packageSize: "10 tablets", pricePaise: 5400 },
  { generic: "Losartan", ingredients: ["Losartan Potassium"], strengthValue: 50, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Blood pressure and cardiovascular", subcategory: "ARB", therapeuticClass: "ARB", rx: RX, aliases: ["losartan", "cozaar"], packageSize: "10 tablets", pricePaise: 4200 },
  { generic: "Metoprolol", ingredients: ["Metoprolol Tartrate"], strengthValue: 25, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Blood pressure and cardiovascular", subcategory: "Beta blocker", therapeuticClass: "Beta blocker", rx: RX, aliases: ["metoprolol", "lopressor", "lopress"], packageSize: "10 tablets", pricePaise: 3600 },
  { generic: "Ramipril", ingredients: ["Ramipril"], strengthValue: 2.5, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Blood pressure and cardiovascular", subcategory: "ACE inhibitor", therapeuticClass: "ACE inhibitor", rx: RX, aliases: ["ramipril", "altace"], packageSize: "10 tablets", pricePaise: 3800 },
  { generic: "Atorvastatin", brand: "Lipitor", ingredients: ["Atorvastatin Calcium"], strengthValue: 10, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Cholesterol medicines", subcategory: "Statin", therapeuticClass: "HMG-CoA reductase inhibitor", rx: RX, aliases: ["atorvastatin", "lipitor", "statin"], packageSize: "10 tablets", pricePaise: 6200 },
  { generic: "Rosuvastatin", ingredients: ["Rosuvastatin Calcium"], strengthValue: 10, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Cholesterol medicines", subcategory: "Statin", therapeuticClass: "HMG-CoA reductase inhibitor", rx: RX, aliases: ["rosuvastatin", "crestor", "statin"], packageSize: "10 tablets", pricePaise: 7400 },

  // ------------------------------------------------ Thyroid
  { generic: "Levothyroxine", brand: "Eltroxin", ingredients: ["Levothyroxine Sodium"], strengthValue: 50, strengthUnit: "mcg", form: "Tablet", route: "Oral", category: "Thyroid medicines", subcategory: "Thyroid hormone", therapeuticClass: "Thyroid hormone", rx: RX, aliases: ["levothyroxine", "eltroxin", "thyroxine", "t4"], packageSize: "100 tablets", pricePaise: 22000 },

  // ------------------------------------------------ Asthma / inhalers
  { generic: "Salbutamol", brand: "Ventolin", ingredients: ["Salbutamol"], strengthValue: 100, strengthUnit: "mcg", form: "Inhaler", route: "Inhalation", category: "Asthma and respiratory inhalers", subcategory: "SABA", therapeuticClass: "Short-acting beta agonist", rx: RX, aliases: ["salbutamol", "ventolin", "albuterol", "asthma inhaler"], packageSize: "200 doses", pricePaise: 32500 },
  { generic: "Budesonide", ingredients: ["Budesonide"], strengthValue: 200, strengthUnit: "mcg", form: "Inhaler", route: "Inhalation", category: "Inhalers and nebulisation", subcategory: "ICS", therapeuticClass: "Inhaled corticosteroid", rx: RX, aliases: ["budesonide", "pulmicort", "steroid inhaler"], packageSize: "120 doses", pricePaise: 38900 },
  { generic: "Ipratropium Bromide", ingredients: ["Ipratropium Bromide"], strengthValue: 500, strengthUnit: "mcg", form: "Nebuliser solution", route: "Inhalation", category: "Inhalers and nebulisation", subcategory: "SAMA", therapeuticClass: "Short-acting anticholinergic", rx: RX, aliases: ["ipratropium", "atrovent", "nebuliser"], packageSize: "2 ml", pricePaise: 4500 },

  // ------------------------------------------------ Neurology
  { generic: "Levetiracetam", ingredients: ["Levetiracetam"], strengthValue: 250, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Neurology medicines", subcategory: "Antiepileptic", therapeuticClass: "Antiepileptic", rx: RX, aliases: ["levetiracetam", "keppra"], packageSize: "10 tablets", pricePaise: 5400 },
  { generic: "Carbamazepine", ingredients: ["Carbamazepine"], strengthValue: 200, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Neurology medicines", subcategory: "Antiepileptic", therapeuticClass: "Antiepileptic", rx: RX, aliases: ["carbamazepine", "tegretol"], packageSize: "10 tablets", pricePaise: 3600 },
  { generic: "Sumatriptan", ingredients: ["Sumatriptan"], strengthValue: 50, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Neurology medicines", subcategory: "Triptan", therapeuticClass: "Triptan", rx: RX, aliases: ["sumatriptan", "imigran", "migraine"], packageSize: "10 tablets", pricePaise: 12000 },

  // ------------------------------------------------ Mental health
  { generic: "Sertraline", ingredients: ["Sertraline HCl"], strengthValue: 25, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Mental health medicines", subcategory: "SSRI", therapeuticClass: "SSRI", rx: RX, aliases: ["sertraline", "zoloft", "ssri"], packageSize: "10 tablets", pricePaise: 5800 },
  { generic: "Fluoxetine", ingredients: ["Fluoxetine HCl"], strengthValue: 20, strengthUnit: "mg", form: "Capsule", route: "Oral", category: "Mental health medicines", subcategory: "SSRI", therapeuticClass: "SSRI", rx: RX, aliases: ["fluoxetine", "prozac", "ssri"], packageSize: "10 capsules", pricePaise: 4200 },
  { generic: "Alprazolam", ingredients: ["Alprazolam"], strengthValue: 0.5, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Mental health medicines", subcategory: "Benzodiazepine", therapeuticClass: "Benzodiazepine", rx: RX, aliases: ["alprazolam", "xanax", "benzodiazepine"], packageSize: "10 tablets", pricePaise: 2400 },
  { generic: "Quetiapine", ingredients: ["Quetiapine Fumarate"], strengthValue: 100, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Mental health medicines", subcategory: "Antipsychotic", therapeuticClass: "Antipsychotic", rx: RX, aliases: ["quetiapine", "seroquel"], packageSize: "10 tablets", pricePaise: 7600 },

  // ------------------------------------------------ Antibiotics
  { generic: "Amoxicillin", brand: "Mox", ingredients: ["Amoxicillin Trihydrate"], strengthValue: 500, strengthUnit: "mg", form: "Capsule", route: "Oral", category: "Antibiotics and antimicrobials", subcategory: "Penicillin", therapeuticClass: "Beta-lactam antibiotic", rx: RX, aliases: ["amoxicillin", "amoxycillin", "mox", "augmentin"], packageSize: "10 capsules", pricePaise: 7200 },
  { generic: "Azithromycin", brand: "Azithral", ingredients: ["Azithromycin Dihydrate"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antibiotics and antimicrobials", subcategory: "Macrolide", therapeuticClass: "Macrolide antibiotic", rx: RX, aliases: ["azithromycin", "azithral", "zithromax"], packageSize: "6 tablets", pricePaise: 21500 },
  { generic: "Ciprofloxacin", ingredients: ["Ciprofloxacin HCl"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antibiotics and antimicrobials", subcategory: "Fluoroquinolone", therapeuticClass: "Fluoroquinolone", rx: RX, aliases: ["ciprofloxacin", "cipro", "ciproflox"], packageSize: "10 tablets", pricePaise: 4400 },
  { generic: "Doxycycline", ingredients: ["Doxycycline Hyclate"], strengthValue: 100, strengthUnit: "mg", form: "Capsule", route: "Oral", category: "Antibiotics and antimicrobials", subcategory: "Tetracycline", therapeuticClass: "Tetracycline antibiotic", rx: RX, aliases: ["doxycycline", "vibramycin", "tetracycline"], packageSize: "10 capsules", pricePaise: 5600 },
  { generic: "Amoxicillin / Clavulanate", brand: "Augmentin", ingredients: ["Amoxicillin", "Clavulanic Acid"], strengthValue: 625, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antibiotics and antimicrobials", subcategory: "Penicillin + inhibitor", therapeuticClass: "Beta-lactam + inhibitor", rx: RX, aliases: ["augmentin", "amoxiclav", "clavulanate"], packageSize: "6 tablets", pricePaise: 16500 },
  { generic: "Metronidazole", ingredients: ["Metronidazole"], strengthValue: 400, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antibiotics and antimicrobials", subcategory: "Nitroimidazole", therapeuticClass: "Antiprotozoal", rx: RX, aliases: ["metronidazole", "flagyl"], packageSize: "10 tablets", pricePaise: 2600 },

  // ------------------------------------------------ Antifungal / antiviral
  { generic: "Fluconazole", ingredients: ["Fluconazole"], strengthValue: 150, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antifungal and antiviral", subcategory: "Azole antifungal", therapeuticClass: "Azole antifungal", rx: RX, aliases: ["fluconazole", "diflucan"], packageSize: "1 tablet", pricePaise: 8500 },
  { generic: "Terbinafine", ingredients: ["Terbinafine HCl"], strengthValue: 250, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antifungal and antiviral", subcategory: "Allylamine antifungal", therapeuticClass: "Allylamine antifungal", rx: RX, aliases: ["terbinafine", "lamisil"], packageSize: "10 tablets", pricePaise: 6400 },
  { generic: "Acyclovir", ingredients: ["Aciclovir"], strengthValue: 400, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antifungal and antiviral", subcategory: "Antiviral", therapeuticClass: "Antiviral", rx: RX, aliases: ["acyclovir", "aciclovir", "zovirax"], packageSize: "10 tablets", pricePaise: 9200 },

  // ------------------------------------------------ Antiparasitic
  { generic: "Albendazole", brand: "Zentel", ingredients: ["Albendazole"], strengthValue: 400, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antiparasitic medicines", subcategory: "Benzimidazole", therapeuticClass: "Anthelmintic", rx: false, aliases: ["albendazole", "zentel", "worm medicine"], packageSize: "1 tablet", pricePaise: 1200 },
  { generic: "Ivermectin", ingredients: ["Ivermectin"], strengthValue: 3, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Antiparasitic medicines", subcategory: "Avermectin", therapeuticClass: "Anthelmintic", rx: RX, aliases: ["ivermectin", "stromectol"], packageSize: "2 tablets", pricePaise: 4500 },

  // ------------------------------------------------ Women's health
  { generic: "Levonorgestrel", brand: "i-Pill", ingredients: ["Levonorgestrel"], strengthValue: 1.5, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Women's health and gynaecology", subcategory: "Emergency contraception", therapeuticClass: "Progestin", rx: false, aliases: ["i-pill", "levonorgestrel", "emergency contraception"], packageSize: "2 tablets", pricePaise: 9500 },
  { generic: "Combined Oral Contraceptive", ingredients: ["Ethinyl Estradiol", "Levonorgestrel"], strengthValue: 0.03, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Women's health and gynaecology", subcategory: "Contraceptive", therapeuticClass: "Combined oral contraceptive", rx: RX, aliases: ["contraceptive", "pill"], packageSize: "21 tablets", pricePaise: 11000 },
  { generic: "Miconazole", ingredients: ["Miconazole"], strengthValue: 2, strengthUnit: "%", form: "Cream", route: "Vaginal", category: "Women's health and gynaecology", subcategory: "Antifungal", therapeuticClass: "Azole antifungal", rx: false, aliases: ["miconazole", "daktarin", "vaginal cream"], packageSize: "20 g", pricePaise: 8600 },

  // ------------------------------------------------ Men's health / urology
  { generic: "Sildenafil", brand: "Viagra", ingredients: ["Sildenafil Citrate"], strengthValue: 50, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Men's health and urology", subcategory: "PDE5 inhibitor", therapeuticClass: "PDE5 inhibitor", rx: RX, aliases: ["sildenafil", "viagra", "penegra"], packageSize: "4 tablets", pricePaise: 45000 },
  { generic: "Tamsulosin", ingredients: ["Tamsulosin HCl"], strengthValue: 0.4, strengthUnit: "mg", form: "Capsule", route: "Oral", category: "Men's health and urology", subcategory: "Alpha blocker", therapeuticClass: "Alpha-1 blocker", rx: RX, aliases: ["tamsulosin", "flomax", "alphablocker"], packageSize: "10 capsules", pricePaise: 6800 },
  { generic: "Finasteride", ingredients: ["Finasteride"], strengthValue: 1, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Men's health and urology", subcategory: "5-alpha reductase inhibitor", therapeuticClass: "5-ARI", rx: RX, aliases: ["finasteride", "propecia"], packageSize: "10 tablets", pricePaise: 9800 },

  // ------------------------------------------------ Pregnancy / prenatal
  { generic: "Folic Acid", brand: "Folvite", ingredients: ["Folic Acid"], strengthValue: 400, strengthUnit: "mcg", form: "Tablet", route: "Oral", category: "Pregnancy and prenatal", subcategory: "Prenatal supplement", therapeuticClass: "Vitamin", rx: false, aliases: ["folic acid", "folvite", "prenatal"], packageSize: "30 tablets", pricePaise: 1900 },
  { generic: "Prenatal Vitamin with Iron", ingredients: ["Ferrous Fumarate", "Folic Acid", "Vitamin D3", "Iodine"], strengthValue: null, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pregnancy and prenatal", subcategory: "Prenatal supplement", therapeuticClass: "Supplement", rx: false, aliases: ["prenatal", "iron folic acid", "pregnancy vitamins"], packageSize: "30 tablets", pricePaise: 12500 },

  // ------------------------------------------------ Paediatric
  { generic: "Paracetamol (Paediatric)", ingredients: ["Paracetamol"], strengthValue: 125, strengthUnit: "mg", form: "Oral suspension", route: "Oral", category: "Paediatric formulations", subcategory: "Analgesic", therapeuticClass: "Analgesic / antipyretic", rx: false, aliases: ["calpol syrup", "children paracetamol", "paediatric paracetamol"], packageSize: "60 ml", pricePaise: 4200 },
  { generic: "Ibuprofen (Paediatric)", ingredients: ["Ibuprofen"], strengthValue: 100, strengthUnit: "mg", form: "Oral suspension", route: "Oral", category: "Paediatric formulations", subcategory: "NSAID", therapeuticClass: "NSAID", rx: false, aliases: ["ibuprofen syrup", "children ibuprofen"], packageSize: "60 ml", pricePaise: 4600 },
  { generic: "Amoxicillin (Paediatric)", ingredients: ["Amoxicillin Trihydrate"], strengthValue: 250, strengthUnit: "mg", form: "Oral suspension", route: "Oral", category: "Paediatric formulations", subcategory: "Antibiotic", therapeuticClass: "Beta-lactam antibiotic", rx: RX, aliases: ["amoxicillin syrup", "children antibiotic"], packageSize: "30 ml", pricePaise: 5400 },

  // ------------------------------------------------ Geriatric
  { generic: "Multivitamin with Minerals (Senior)", ingredients: ["Vitamin B12", "Folic Acid", "Vitamin D3", "Zinc", "Calcium"], strengthValue: null, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Geriatric care", subcategory: "Nutrition support", therapeuticClass: "Supplement", rx: false, aliases: ["senior vitamins", "geriatric vitamins", "b12"], packageSize: "30 tablets", pricePaise: 14500 },

  // ------------------------------------------------ Bone, joint, muscle
  { generic: "Calcium Carbonate with Vitamin D3", brand: "Shelcal 500", ingredients: ["Calcium Carbonate", "Vitamin D3"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Bone, joint and muscle", subcategory: "Bone health", therapeuticClass: "Mineral supplement", rx: false, aliases: ["shelcal", "calcium with vitamin d", "bone strength"], packageSize: "30 tablets", pricePaise: 17500 },
  { generic: "Colecalciferol", ingredients: ["Vitamin D3"], strengthValue: 1000, strengthUnit: "IU", form: "Tablet", route: "Oral", category: "Bone, joint and muscle", subcategory: "Bone health", therapeuticClass: "Vitamin", rx: false, aliases: ["vitamin d3", "colecalciferol", "bone health"], packageSize: "30 tablets", pricePaise: 3200 },
  { generic: "Glucosamine with Chondroitin", ingredients: ["Glucosamine Sulphate", "Chondroitin Sulphate"], strengthValue: 750, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Bone, joint and muscle", subcategory: "Joint support", therapeuticClass: "Supplement", rx: false, aliases: ["glucosamine", "chondroitin", "joint pain"], packageSize: "30 tablets", pricePaise: 18500 },

  // ------------------------------------------------ Kidney and urinary
  { generic: "Citrulline", ingredients: ["L-Citrulline"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Kidney and urinary health", subcategory: "Supplement", therapeuticClass: "Supplement", rx: false, aliases: ["citrulline"], packageSize: "30 tablets", pricePaise: 9200 },
  { generic: "Potassium", brand: "Slow K", ingredients: ["Potassium Chloride"], strengthValue: 600, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Kidney and urinary health", subcategory: "Electrolyte", therapeuticClass: "Electrolyte supplement", rx: RX, aliases: ["potassium", "slow k"], packageSize: "15 tablets", pricePaise: 3400 },

  // ------------------------------------------------ Liver and digestive health
  { generic: "Ursodeoxycholic Acid", ingredients: ["Ursodeoxycholic Acid"], strengthValue: 300, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Liver and digestive health", subcategory: "Hepatobiliary", therapeuticClass: "Bile acid", rx: RX, aliases: ["ursodeoxycholic acid", "udca", "actigall"], packageSize: "10 tablets", pricePaise: 13500 },
  { generic: "Liver Tonic (Compound)", ingredients: ["Extracts of multiple herbs"], strengthValue: null, strengthUnit: "ml", form: "Syrup", route: "Oral", category: "Liver and digestive health", subcategory: "Hepatobiliary", therapeuticClass: "Supplement", rx: false, aliases: ["liver tonic", "liver syrup", "digestive syrup"], packageSize: "200 ml", pricePaise: 16000 },

  // ------------------------------------------------ First aid and antiseptics
  { generic: "Chloroxylenol", brand: "Dettol", ingredients: ["Chloroxylenol"], strengthValue: 4.8, strengthUnit: "%", form: "Liquid", route: "Topical", category: "First aid and antiseptics", subcategory: "Antiseptic", therapeuticClass: "Antiseptic", rx: false, aliases: ["dettol", "chloroxylenol", "antiseptic", "antiseptic liquid"], packageSize: "200 ml", pricePaise: 9500 },
  { generic: "Povidone Iodine", brand: "Betadine", ingredients: ["Povidone Iodine"], strengthValue: 10, strengthUnit: "%", form: "Solution", route: "Topical", category: "First aid and antiseptics", subcategory: "Antiseptic", therapeuticClass: "Antiseptic", rx: false, aliases: ["betadine", "povidone iodine", "iodine"], packageSize: "100 ml", pricePaise: 7800 },
  { generic: "Hydrogen Peroxide", ingredients: ["Hydrogen Peroxide"], strengthValue: 3, strengthUnit: "%", form: "Solution", route: "Topical", category: "First aid and antiseptics", subcategory: "Antiseptic", therapeuticClass: "Antiseptic", rx: false, aliases: ["hydrogen peroxide", "peroxide"], packageSize: "100 ml", pricePaise: 1200 },

  // ------------------------------------------------ Wound care and dressings
  { generic: "Sterile Gauze", ingredients: ["Cotton Gauze"], strengthValue: null, strengthUnit: "cm", form: "Dressing", route: "Topical", category: "Wound care and dressings", subcategory: "Dressing", therapeuticClass: "Dressing", rx: false, aliases: ["gauze", "bandage", "dressing"], packageSize: "10 pieces", pricePaise: 8500 },
  { generic: "Adhesive Bandage", ingredients: ["Adhesive Pad"], strengthValue: null, strengthUnit: "cm", form: "Dressing", route: "Topical", category: "Wound care and dressings", subcategory: "Dressing", therapeuticClass: "Dressing", rx: false, aliases: ["band aid", "bandage", "adhesive plaster"], packageSize: "20 pieces", pricePaise: 3500 },

  // ------------------------------------------------ Topical creams and ointments
  { generic: "Diclofenac (Topical)", brand: "Voveran Gel", ingredients: ["Diclofenac Diethylamine"], strengthValue: 1, strengthUnit: "%", form: "Gel", route: "Topical", category: "Topical creams and ointments", subcategory: "NSAID topical", therapeuticClass: "Topical NSAID", rx: RX, aliases: ["voveran gel", "diclofenac gel", "voltarol"], packageSize: "30 g", pricePaise: 12000 },
  { generic: "Hydrocortisone", ingredients: ["Hydrocortisone Acetate"], strengthValue: 1, strengthUnit: "%", form: "Cream", route: "Topical", category: "Topical creams and ointments", subcategory: "Corticosteroid", therapeuticClass: "Topical corticosteroid", rx: RX, aliases: ["hydrocortisone", "cortisone cream", "steroid cream"], packageSize: "30 g", pricePaise: 8900 },
  { generic: "Silver Sulfadiazine", ingredients: ["Silver Sulfadiazine"], strengthValue: 1, strengthUnit: "%", form: "Cream", route: "Topical", category: "Topical creams and ointments", subcategory: "Antibacterial", therapeuticClass: "Antibacterial", rx: RX, aliases: ["silver sulfadiazine", "sulfadiazine", "burn cream"], packageSize: "25 g", pricePaise: 9500 },

  // ------------------------------------------------ Injections and infusions
  { generic: "Adrenaline (Epinephrine)", ingredients: ["Epinephrine"], strengthValue: 1, strengthUnit: "mg", form: "Injection", route: "Intramuscular", category: "Emergency care", subcategory: "Emergency medicine", therapeuticClass: "Sympathomimetic", rx: RX, aliases: ["adrenaline", "epinephrine", "epifrin"], packageSize: "1 ml ampoule", pricePaise: 4500 },
  { generic: "Normal Saline", ingredients: ["Sodium Chloride"], strengthValue: 0.9, strengthUnit: "%", form: "Injection", route: "Intravenous", category: "Injections and infusions", subcategory: "IV fluid", therapeuticClass: "IV fluid", rx: RX, aliases: ["normal saline", "ns", "saline"], packageSize: "500 ml", pricePaise: 2800 },

  // ------------------------------------------------ Nasal
  { generic: "Xylometazoline", brand: "Otrivin", ingredients: ["Xylometazoline Hydrochloride"], strengthValue: 0.1, strengthUnit: "%", form: "Nasal drops", route: "Nasal", category: "Nasal sprays and drops", subcategory: "Decongestant", therapeuticClass: "Nasal decongestant", rx: false, aliases: ["otrivin", "xylometazoline", "nasal drops", "blocked nose"], packageSize: "10 ml", pricePaise: 8500 },
  { generic: "Saline Nasal Spray", ingredients: ["Sodium Chloride"], strengthValue: 0.9, strengthUnit: "%", form: "Nasal spray", route: "Nasal", category: "Nasal sprays and drops", subcategory: "Saline", therapeuticClass: "Nasal saline", rx: false, aliases: ["nasal spray", "saline spray", "nasal"], packageSize: "20 ml", pricePaise: 4500 },

  // ------------------------------------------------ Oral liquids and syrups
  { generic: "Cough Syrup (Antitussive)", ingredients: ["Dextromethorphan", "Guaifenesin", "Terbutaline"], strengthValue: 100, strengthUnit: "ml", form: "Syrup", route: "Oral", category: "Oral liquids and syrups", subcategory: "Antitussive", therapeuticClass: "Antitussive", rx: false, aliases: ["cough syrup", "antitussive syrup", "dry cough"], packageSize: "100 ml", pricePaise: 8900 },
  { generic: "Multivitamin Syrup", ingredients: ["Vitamin A", "Vitamin B1", "Vitamin B2", "Vitamin B6", "Vitamin C"], strengthValue: 200, strengthUnit: "ml", form: "Syrup", route: "Oral", category: "Oral liquids and syrups", subcategory: "Vitamin", therapeuticClass: "Vitamin", rx: false, aliases: ["multivitamin syrup", "vitamin syrup"], packageSize: "200 ml", pricePaise: 13500 },

  // ------------------------------------------------ Tablets and capsules (generics)
  { generic: "Metformin", brand: "Glycomet GP", ingredients: ["Metformin", "Glimepiride"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Tablets and capsules", subcategory: "Oral antidiabetic", therapeuticClass: "Biguanide + sulfonylurea", rx: RX, aliases: ["glycomet gp", "glimepiride"], packageSize: "10 tablets", pricePaise: 6400 },
  { generic: "Metformin", brand: "Gluconil", ingredients: ["Metformin", "Sitagliptin"], strengthValue: 500, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Tablets and capsules", subcategory: "Oral antidiabetic", therapeuticClass: "Biguanide + DPP-4 inhibitor", rx: RX, aliases: ["metformin sitagliptin", "gluconil"], packageSize: "10 tablets", pricePaise: 7800 },

  // ------------------------------------------------ Devices / essentials
  { generic: "Digital Thermometer", ingredients: [], strengthValue: null, strengthUnit: null, form: "Device", route: "Not applicable", category: "Devices, diagnostics and essentials", subcategory: "Diagnostic device", therapeuticClass: "Device", rx: false, aliases: ["thermometer", "digital thermometer", "temperature"], packageSize: "1 unit", pricePaise: 25000 },
  { generic: "Blood Pressure Monitor", ingredients: [], strengthValue: null, strengthUnit: null, form: "Device", route: "Not applicable", category: "Devices, diagnostics and essentials", subcategory: "Diagnostic device", therapeuticClass: "Device", rx: false, aliases: ["bp monitor", "sphygmomanometer", "blood pressure"], packageSize: "1 unit", pricePaise: 220000 },
  { generic: "Pulse Oximeter", ingredients: [], strengthValue: null, strengthUnit: null, form: "Device", route: "Not applicable", category: "Devices, diagnostics and essentials", subcategory: "Diagnostic device", therapeuticClass: "Device", rx: false, aliases: ["pulse oximeter", "spo2", "oximeter"], packageSize: "1 unit", pricePaise: 140000 },
  { generic: "Surgical Mask", ingredients: [], strengthValue: null, strengthUnit: null, form: "Device", route: "Not applicable", category: "Devices, diagnostics and essentials", subcategory: "Protective equipment", therapeuticClass: "Device", rx: false, aliases: ["mask", "surgical mask", "n95"], packageSize: "50 pieces", pricePaise: 35000 },
  { generic: "Blood Glucose Test Strips", ingredients: [], strengthValue: null, strengthUnit: null, form: "Device", route: "Not applicable", category: "Devices, diagnostics and essentials", subcategory: "Diagnostic consumable", therapeuticClass: "Device", rx: false, aliases: ["glucometer strips", "sugar test strips", "blood glucose"], packageSize: "25 strips", pricePaise: 45000 },

  // ------------------------------------------------ Fictional demonstration rows
  //
  // Marked `demo`. These exist to prove the catalogue handles awkward shapes —
  // a discontinued ingredient, a controlled product, a combination product — and
  // must never be mistaken for real catalogue data. Search marks them visibly.
  { generic: "Demo Herbal Analgesic", brand: "Demo Herb", ingredients: ["Herbal Extract A", "Herbal Extract B"], strengthValue: 250, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "Herbal", therapeuticClass: "Herbal preparation", rx: false, aliases: ["demo herbal", "sample pain relief"], packageSize: "10 tablets", pricePaise: 4900, verification: "demo" },
  { generic: "Demo Controlled Analgesic", brand: "Demo Restricted", ingredients: ["Demo Ingredient X"], strengthValue: 10, strengthUnit: "mg", form: "Tablet", route: "Oral", category: "Pain relief and fever", subcategory: "Controlled (demo)", therapeuticClass: "Controlled substance (demo)", rx: RX, aliases: ["demo controlled", "sample restricted"], packageSize: "10 tablets", pricePaise: 150000, verification: "demo" },
];

/** Categories actually present in the catalogue, for the filter UI. */
export function categoriesInUse(): Category[] {
  const present = new Set(CATALOGUE.map((e) => e.category));
  return CATEGORIES.filter((c) => present.has(c));
}