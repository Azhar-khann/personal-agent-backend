/**
 * The catalogue, per App_design_spec.md §3: "You fill this table yourself,
 * users never add to it."
 *
 * `onboarding_schema` drives the extra questions on the business signup form.
 * `request_schema` tells the agent what it must know before it can search.
 * `aliases` are fed to the agent so it recognises "trim" as a haircut.
 *
 * Adding a category needs no code change — only rows here.
 */

import type { Confirmation, LocationMode, PricingMode } from "../service-settings.js";

export type OnboardingField = {
  key: string;
  type: "bool" | "text" | "number" | "select";
  label: string;
  required: boolean;
  options?: string[];
};

export type OnboardingSchema = { fields: OnboardingField[] };
export type RequestSchema = { required: string[]; optional: string[] };

export type CategorySeed = {
  id: string;
  name: string;
  groupName: string;
  onboardingSchema: OnboardingSchema;
  requestSchema: RequestSchema;
  agentHints: string;
  defaultDurationMin: number;
  defaultRadiusKm: number;
  /** e.g. 120 for AC servicing. null when the category isn't recurring. */
  recurringDefaultDays: number | null;
};

export type CanonicalServiceSeed = {
  id: string;
  categoryId: string;
  name: string;
  aliases: string[];
  /** Length of the single job step. */
  durationMin: number;
  /** Overrides of the category's defaults below, for one service. */
  locationMode?: LocationMode;
  pricingMode?: PricingMode;
  unitLabel?: string;
  confirmation?: Confirmation;
};

/**
 * Default service settings by category. Home services happen at the
 * customer's, at a from-price the visit confirms; everything else is a fixed
 * price at the shop. All instant and single-step — the Phase 1 set.
 */
export const CATEGORY_SERVICE_DEFAULTS: Record<
  string,
  { locationMode: LocationMode; pricingMode: PricingMode }
> = {
  barber: { locationMode: "at_business", pricingMode: "fixed" },
  salon: { locationMode: "at_business", pricingMode: "fixed" },
  dentist: { locationMode: "at_business", pricingMode: "fixed" },
  car_service: { locationMode: "at_business", pricingMode: "fixed" },
  ac_maintenance: { locationMode: "at_customer", pricingMode: "from" },
  plumber: { locationMode: "at_customer", pricingMode: "from" },
  handyman: { locationMode: "at_customer", pricingMode: "from" },
};

/** Every category's request_schema needs at least these two (§4). */
const BASE_REQUEST: RequestSchema = {
  required: ["service", "time_window"],
  optional: ["budget_max", "notes"],
};

export const CATEGORIES: CategorySeed[] = [
  {
    id: "barber",
    name: "Barber",
    groupName: "Personal care",
    onboardingSchema: {
      fields: [
        { key: "walk_ins", type: "bool", label: "Accept walk-ins", required: true },
        {
          key: "gender_served",
          type: "select",
          label: "Who do you serve",
          required: true,
          options: ["men", "women", "both"],
        },
      ],
    },
    requestSchema: {
      required: ["service", "time_window"],
      optional: ["gender_preference", "budget_max", "notes"],
    },
    agentHints:
      "Haircuts, beard trims, shaves, grooming. Say barber for men's grooming; " +
      "a salon doing colouring or styling for women is 'salon', not 'barber'.",
    defaultDurationMin: 30,
    defaultRadiusKm: 10,
    recurringDefaultDays: null,
  },
  {
    id: "salon",
    name: "Salon",
    groupName: "Personal care",
    onboardingSchema: {
      fields: [
        { key: "ladies_only", type: "bool", label: "Ladies only", required: true },
        { key: "home_service", type: "bool", label: "Offer home service", required: true },
      ],
    },
    requestSchema: {
      required: ["service", "time_window"],
      optional: ["gender_preference", "budget_max", "notes"],
    },
    agentHints:
      "Hair colouring, styling, blow-dry, manicure, pedicure, facials, waxing. " +
      "Prefer over 'barber' when the request involves colour, nails or beauty treatments.",
    defaultDurationMin: 60,
    defaultRadiusKm: 10,
    recurringDefaultDays: null,
  },
  {
    id: "dentist",
    name: "Dentist",
    groupName: "Health",
    onboardingSchema: {
      fields: [
        { key: "insurance_accepted", type: "bool", label: "Accept insurance", required: true },
        { key: "emergency_slots", type: "bool", label: "Keep emergency slots", required: false },
      ],
    },
    requestSchema: {
      required: ["service", "time_window"],
      optional: ["budget_max", "insurance", "notes"],
    },
    agentHints:
      "Teeth: check-ups, cleaning, fillings, extractions, whitening, braces. " +
      "Toothache and dental pain belong here.",
    defaultDurationMin: 30,
    defaultRadiusKm: 15,
    recurringDefaultDays: 180,
  },
  {
    id: "ac_maintenance",
    name: "AC maintenance",
    groupName: "Home services",
    onboardingSchema: {
      fields: [
        { key: "callout_fee_aed", type: "number", label: "Callout fee (AED)", required: true },
        { key: "emergency_service", type: "bool", label: "24/7 emergency", required: false },
      ],
    },
    requestSchema: {
      required: ["service", "time_window"],
      optional: ["budget_max", "unit_count", "notes"],
    },
    agentHints:
      "Air conditioning: servicing, cleaning, gas refill, repair, duct cleaning. " +
      "The recurring one — people service AC roughly every four months in Dubai.",
    defaultDurationMin: 90,
    defaultRadiusKm: 25,
    recurringDefaultDays: 120,
  },
  {
    id: "plumber",
    name: "Plumber",
    groupName: "Home services",
    onboardingSchema: {
      fields: [
        { key: "callout_fee_aed", type: "number", label: "Callout fee (AED)", required: true },
        { key: "emergency_service", type: "bool", label: "24/7 emergency", required: false },
      ],
    },
    requestSchema: {
      required: ["service", "time_window"],
      optional: ["budget_max", "urgency", "notes"],
    },
    agentHints:
      "Water: leaks, blocked drains, taps, toilets, water heaters, pipes. " +
      "Distinct from 'handyman' — if water is involved, prefer plumber. " +
      "If the user is vague ('something broken'), ask rather than guess.",
    defaultDurationMin: 60,
    defaultRadiusKm: 20,
    recurringDefaultDays: null,
  },
  {
    id: "handyman",
    name: "Handyman",
    groupName: "Home services",
    onboardingSchema: {
      fields: [
        { key: "callout_fee_aed", type: "number", label: "Callout fee (AED)", required: true },
        { key: "min_job_aed", type: "number", label: "Minimum job value (AED)", required: false },
      ],
    },
    requestSchema: {
      required: ["service", "time_window"],
      optional: ["budget_max", "notes"],
    },
    agentHints:
      "General odd jobs: mounting, furniture assembly, painting, door and lock " +
      "fixes, curtain rails. The catch-all — if the job is specifically water " +
      "(plumber) or electrical, prefer the specific category. Ask when unsure: " +
      "plumber-versus-handyman is the confusion that actually hurts.",
    defaultDurationMin: 60,
    defaultRadiusKm: 20,
    recurringDefaultDays: null,
  },
  {
    id: "car_service",
    name: "Car service",
    groupName: "Vehicle",
    onboardingSchema: {
      fields: [
        { key: "pickup_dropoff", type: "bool", label: "Offer pickup and drop-off", required: true },
        { key: "brands_served", type: "text", label: "Brands served", required: false },
      ],
    },
    requestSchema: {
      required: ["service", "time_window"],
      optional: ["budget_max", "car_make", "notes"],
    },
    agentHints:
      "Cars: oil change, servicing, tyres, battery, brakes, AC regas, " +
      "pre-purchase inspection. Also car registration renewal testing.",
    defaultDurationMin: 120,
    defaultRadiusKm: 25,
    recurringDefaultDays: 180,
  },
];

export const CANONICAL_SERVICES: CanonicalServiceSeed[] = [
  // --- barber -------------------------------------------------------------
  {
    id: "mens_haircut",
    categoryId: "barber",
    name: "Men's Haircut",
    aliases: ["haircut", "hair cut", "trim", "gents haircut", "mens cut", "cut"],
    durationMin:30,
  },
  {
    id: "beard_trim",
    categoryId: "barber",
    name: "Beard Trim",
    aliases: ["beard", "beard shaping", "beard cut"],
    durationMin:20,
  },
  {
    id: "shave",
    categoryId: "barber",
    name: "Shave",
    aliases: ["wet shave", "razor shave", "clean shave"],
    durationMin:30,
  },
  {
    id: "kids_haircut",
    categoryId: "barber",
    name: "Kids' Haircut",
    aliases: ["child haircut", "boy haircut", "kids cut"],
    durationMin:20,
  },

  // --- salon --------------------------------------------------------------
  {
    id: "womens_haircut",
    categoryId: "salon",
    name: "Women's Haircut",
    aliases: ["ladies haircut", "ladies cut", "womens cut"],
    durationMin:60,
  },
  {
    id: "hair_colour",
    categoryId: "salon",
    name: "Hair Colouring",
    aliases: ["hair color", "colour", "dye", "highlights", "balayage"],
    durationMin:120,
  },
  {
    id: "blow_dry",
    categoryId: "salon",
    name: "Blow Dry",
    aliases: ["blowdry", "blow-dry", "styling"],
    durationMin:45,
  },
  {
    id: "manicure",
    categoryId: "salon",
    name: "Manicure",
    aliases: ["nails", "gel nails", "nail polish"],
    durationMin:45,
  },
  {
    id: "pedicure",
    categoryId: "salon",
    name: "Pedicure",
    aliases: ["foot care", "toe nails"],
    durationMin:60,
  },
  {
    id: "facial",
    categoryId: "salon",
    name: "Facial",
    aliases: ["face treatment", "skin treatment"],
    durationMin:60,
  },

  // --- dentist ------------------------------------------------------------
  {
    id: "dental_checkup",
    categoryId: "dentist",
    name: "Dental Check-up",
    aliases: ["checkup", "check up", "dental exam", "consultation"],
    durationMin:30,
  },
  {
    id: "teeth_cleaning",
    categoryId: "dentist",
    name: "Teeth Cleaning",
    aliases: ["scaling", "polishing", "hygienist", "cleaning"],
    durationMin:45,
  },
  {
    id: "filling",
    categoryId: "dentist",
    name: "Filling",
    aliases: ["cavity", "tooth filling", "composite"],
    durationMin:45,
  },
  {
    id: "tooth_extraction",
    categoryId: "dentist",
    name: "Tooth Extraction",
    aliases: ["pull tooth", "remove tooth", "extraction"],
    durationMin:45,
  },
  {
    id: "teeth_whitening",
    categoryId: "dentist",
    name: "Teeth Whitening",
    aliases: ["whitening", "bleaching"],
    durationMin:60,
  },

  // --- ac_maintenance -----------------------------------------------------
  {
    id: "ac_servicing",
    categoryId: "ac_maintenance",
    name: "AC Servicing",
    aliases: ["ac service", "ac maintenance", "aircon service", "ac cleaning"],
    durationMin:90,
  },
  {
    id: "ac_gas_refill",
    categoryId: "ac_maintenance",
    name: "AC Gas Refill",
    aliases: ["gas refill", "freon", "regas", "ac not cooling"],
    durationMin:60,
  },
  {
    id: "ac_repair",
    categoryId: "ac_maintenance",
    name: "AC Repair",
    aliases: ["ac broken", "ac fix", "aircon repair"],
    durationMin:90,
  },
  {
    id: "duct_cleaning",
    categoryId: "ac_maintenance",
    name: "Duct Cleaning",
    aliases: ["ducting", "air duct", "vent cleaning"],
    durationMin:180,
  },

  // --- plumber ------------------------------------------------------------
  {
    id: "leak_repair",
    categoryId: "plumber",
    name: "Leak Repair",
    aliases: ["leak", "leaking pipe", "water leak", "dripping"],
    durationMin:60,
  },
  {
    id: "drain_unblocking",
    categoryId: "plumber",
    name: "Drain Unblocking",
    aliases: ["blocked drain", "clogged", "blockage", "slow drain"],
    durationMin:60,
  },
  {
    id: "water_heater",
    categoryId: "plumber",
    name: "Water Heater Repair",
    aliases: ["geyser", "boiler", "no hot water"],
    durationMin:90,
  },
  {
    id: "tap_toilet_repair",
    categoryId: "plumber",
    name: "Tap & Toilet Repair",
    aliases: ["tap", "faucet", "toilet", "flush", "cistern"],
    durationMin:45,
  },
  {
    id: "water_tank_cleaning",
    categoryId: "plumber",
    name: "Water Tank Cleaning",
    aliases: ["tank cleaning", "water tank"],
    durationMin:120,
  },

  // --- handyman -----------------------------------------------------------
  {
    id: "furniture_assembly",
    categoryId: "handyman",
    name: "Furniture Assembly",
    aliases: ["assemble", "ikea", "flat pack", "build furniture"],
    durationMin:90,
  },
  {
    id: "tv_wall_mounting",
    categoryId: "handyman",
    name: "TV & Wall Mounting",
    aliases: ["mount tv", "hang", "wall mount", "shelf", "picture hanging"],
    durationMin:60,
  },
  {
    id: "painting",
    categoryId: "handyman",
    name: "Painting",
    aliases: ["paint", "wall painting", "touch up"],
    durationMin:240,
  },
  {
    id: "door_lock_repair",
    categoryId: "handyman",
    name: "Door & Lock Repair",
    aliases: ["door", "lock", "handle", "hinge"],
    durationMin:60,
  },
  {
    id: "curtain_installation",
    categoryId: "handyman",
    name: "Curtain Installation",
    aliases: ["curtains", "blinds", "curtain rail"],
    durationMin:60,
  },

  // --- car_service --------------------------------------------------------
  {
    id: "oil_change",
    categoryId: "car_service",
    name: "Oil Change",
    aliases: ["oil", "oil service", "lube"],
    durationMin:45,
  },
  {
    id: "full_car_service",
    categoryId: "car_service",
    name: "Full Service",
    aliases: ["car service", "major service", "full service"],
    durationMin:180,
  },
  {
    id: "tyre_replacement",
    categoryId: "car_service",
    name: "Tyre Replacement",
    aliases: ["tyres", "tires", "puncture", "wheel"],
    durationMin:60,
  },
  {
    id: "battery_replacement",
    categoryId: "car_service",
    name: "Battery Replacement",
    aliases: ["battery", "car wont start", "jump start"],
    durationMin:30,
  },
  {
    id: "brake_service",
    categoryId: "car_service",
    name: "Brake Service",
    aliases: ["brakes", "brake pads", "brake discs"],
    durationMin:120,
  },
  {
    id: "car_ac_regas",
    categoryId: "car_service",
    name: "Car AC Regas",
    aliases: ["car ac", "car aircon", "car cooling"],
    durationMin:60,
  },
];
