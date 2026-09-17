import { describe, expect, it } from "vitest";

import { deliveryFor, type EventFacts } from "./delivery.js";

const facts: EventFacts = {
  businessName: "CoolAir Services",
  businessPhone: "+971501234567",
  serviceName: "AC Servicing",
  customerName: "Sara",
  // 12:00 in Dubai, 13:30 in Kolkata.
  scheduledAt: new Date("2030-01-07T08:00:00Z"),
  from: new Date("2030-01-07T08:00:00Z"),
  to: new Date("2030-01-08T10:00:00Z"),
  serviceAddress: "Villa 7, Jumeirah",
  reason: "technician unwell",
  userTimeZone: "Asia/Kolkata",
  appointmentKind: "job",
  holdExpiresAt: null,
  needsApproval: false,
  amountAed: null,
  estDurationMin: null,
  validUntil: null,
  quantity: null,
  unitLabel: null,
};

describe("deliveryFor", () => {
  it("tells the business about the user's booking, in Dubai time, and not the user", () => {
    expect(deliveryFor("order.confirmed", facts)).toEqual({
      push: { title: "New booking", body: "AC Servicing, Mon 7 Jan, 12:00 — Sara" },
    });
  });

  it("tells the business where a booking moved from and to", () => {
    expect(deliveryFor("order.rescheduled", facts).push?.body).toBe("AC Servicing — Sara: Mon 7 Jan, 12:00 → Tue 8 Jan, 14:00");
  });

  it("tells the business when the user cancels", () => {
    const delivery = deliveryFor("order.cancelled_by_user", facts);
    expect(delivery.push?.title).toBe("Booking cancelled");
    expect(delivery.message).toBeUndefined();
  });

  it("tells the user when the business cancels, in their time zone, and offers to rebook (§6)", () => {
    expect(deliveryFor("order.cancelled_by_business", facts)).toEqual({
      message: "Sorry, CoolAir Services cancelled your AC Servicing on Mon 7 Jan, 13:30 (technician unwell). Want me to find another time?",
      offerRebooking: true,
    });
  });

  it("gives the user a way to dispute a no-show", () => {
    expect(deliveryFor("order.no_show", facts).message).toContain("+971501234567");
  });

  it("reminds the user, with the address for work at their place", () => {
    expect(deliveryFor("appointment.reminder", facts).message).toBe(
      "Reminder: AC Servicing with CoolAir Services, Mon 7 Jan, 13:30, at Villa 7, Jumeirah.",
    );
    expect(deliveryFor("appointment.reminder", { ...facts, serviceAddress: null }).message).toBe(
      "Reminder: AC Servicing with CoolAir Services, Mon 7 Jan, 13:30.",
    );
  });

  it("asks the business to answer a request by its deadline", () => {
    expect(deliveryFor("order.requested", { ...facts, holdExpiresAt: new Date("2030-01-07T06:00:00Z") }).push).toEqual({
      title: "New request",
      body: "AC Servicing, Mon 7 Jan, 12:00 — Sara. Accept or decline by Mon 7 Jan, 10:00",
    });
    expect(deliveryFor("order.requested", { ...facts, appointmentKind: "visit" }).push?.title).toBe("New quote request");
  });

  it("tells the user a request lapsed, and the business too, and offers to rebook", () => {
    const delivery = deliveryFor("order.expired", facts);
    expect(delivery.message).toBe(
      "CoolAir Services didn't confirm your AC Servicing request in time, so it's been released. Want me to find somewhere else?",
    );
    expect(delivery.push?.title).toBe("Request expired");
    expect(delivery.offerRebooking).toBe(true);
  });

  it("sends the user a quote to accept", () => {
    expect(
      deliveryFor("quote.sent", { ...facts, amountAed: 1200, estDurationMin: 240, validUntil: new Date("2030-01-14T08:00:00Z") }).message,
    ).toBe("CoolAir Services quoted AED 1200 for AC Servicing, about 4 hours of work, valid until Mon 14 Jan, 13:30. Open the booking to accept it and pick a time.");
  });

  it("names the step: a pickup, a delivery or a visit", () => {
    expect(deliveryFor("appointment.reminder", { ...facts, appointmentKind: "pickup" }).message).toBe(
      "Reminder: CoolAir Services collects your AC Servicing Mon 7 Jan, 13:30, at Villa 7, Jumeirah.",
    );
    expect(deliveryFor("order.confirmed", { ...facts, appointmentKind: "pickup" }).push?.body).toBe(
      "AC Servicing pickup, Mon 7 Jan, 12:00 — Sara",
    );
  });

  it("tells the user the final price, with the quantity", () => {
    expect(deliveryFor("order.final_price", { ...facts, amountAed: 58.8, quantity: 8.4, unitLabel: "kg" }).message).toBe(
      "CoolAir Services set the final price for your AC Servicing: AED 58.8 for 8.4 kg.",
    );
  });

  it("sends nothing for a completed order, or an event it doesn't know", () => {
    expect(deliveryFor("order.completed", facts)).toEqual({});
    expect(deliveryFor("order.something_new", facts)).toEqual({});
  });
});
