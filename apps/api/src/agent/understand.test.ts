import { describe, expect, it } from "vitest";

import { choiceFromLabel, withoutPlaceholders, type Understanding } from "./understand.js";

const nothing: Understanding = {
  intent: "request",
  starts_new_request: false,
  category_id: null,
  category_candidates: [],
  service_id: null,
  business_name: null,
  choice_number: null,
  time_window: null,
  location: null,
  address: null,
  budget_max_aed: null,
  quantity: null,
  notes: null,
  details: [],
  option_number: null,
  option_time: null,
  order_number: null,
  booking_action: null,
  reply: null,
};

describe("withoutPlaceholders", () => {
  it("treats placeholder text as not given — as the model wrote it in testing", () => {
    const cleaned = withoutPlaceholders({
      ...nothing,
      business_name: ":null",
      address: "/null",
      notes: "N/A",
      category_candidates: ["plumber", "none"],
      details: [{ key: "gender_preference", value: "null" }],
    });
    expect(cleaned.business_name).toBeNull();
    expect(cleaned.address).toBeNull();
    expect(cleaned.notes).toBeNull();
    expect(cleaned.category_candidates).toEqual(["plumber"]);
    expect(cleaned.details).toEqual([]);
  });

  it("treats zero as not given — the model wrote budget 0 for no budget in the evals", () => {
    const cleaned = withoutPlaceholders({ ...nothing, budget_max_aed: 0, quantity: 0, choice_number: 0, option_number: 0, order_number: 0 });
    expect(cleaned).toEqual(nothing);
    expect(withoutPlaceholders({ ...nothing, budget_max_aed: 150, choice_number: 2 })).toMatchObject({ budget_max_aed: 150, choice_number: 2 });
  });

  it("keeps real values, trimmed", () => {
    const cleaned = withoutPlaceholders({ ...nothing, business_name: "  Marina Cuts ", address: "Villa 7, Jumeirah" });
    expect(cleaned.business_name).toBe("Marina Cuts");
    expect(cleaned.address).toBe("Villa 7, Jumeirah");
  });
});

describe("choiceFromLabel", () => {
  const branches = ["Kings Barbers — The Walk, JBR", "Kings Barbers — Al Barsha 1"];

  it("reads a copied label as the choice — as the model answered 'the Al Barsha one' in testing", () => {
    expect(choiceFromLabel(branches, { ...nothing, business_name: "Kings Barbers — Al Barsha 1" })).toBe(2);
  });

  it("reads text found in exactly one label", () => {
    expect(choiceFromLabel(branches, { ...nothing, business_name: "Al Barsha" })).toBe(2);
    expect(choiceFromLabel(["Plumber", "Handyman"], { ...nothing, category_id: "handyman" })).toBe(2);
  });

  it("refuses text that fits several labels, so the question is asked again", () => {
    expect(choiceFromLabel(branches, { ...nothing, business_name: "Kings Barbers" })).toBeNull();
    expect(choiceFromLabel(branches, nothing)).toBeNull();
  });
});
