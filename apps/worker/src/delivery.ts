/**
 * What an order event means for whom. Pure, so the wording and the rules are
 * unit-tested without a database or a browser.
 */

import { BUSINESS_TIME_ZONE, formatWhen } from "@personal-agent/core";

export type EventFacts = {
  businessName: string;
  businessPhone: string;
  serviceName: string;
  customerName: string | null;
  /** The appointment the event is about, if any, and what kind it is. */
  scheduledAt: Date | null;
  appointmentKind: string | null;
  /** For a reschedule. */
  from: Date | null;
  to: Date | null;
  serviceAddress: string | null;
  reason: string | null;
  userTimeZone: string;
  /** A request the business hasn't answered: when it lapses. */
  holdExpiresAt: Date | null;
  /** A move of a booking the business must approve again. */
  needsApproval: boolean;
  /** A quote's amount and length, or a final price. */
  amountAed: number | null;
  estDurationMin: number | null;
  validUntil: Date | null;
  quantity: number | null;
  unitLabel: string | null;
};

export type Delivery = {
  /** A browser push to the business's staff. */
  push?: { title: string; body: string };
  /** An assistant message in the user's conversation. */
  message?: string;
  /** Prefill the conversation so "yes, tomorrow" searches for the same service again. */
  offerRebooking?: boolean;
};

/** "2 hours", "90 minutes", "3 days". */
function duration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} day${minutes === 24 * 60 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

/**
 * Nobody is told about what they did themselves: a business hears about the
 * user's bookings, requests, moves, cancellations and quote answers; the user
 * hears about the business's answers, cancellations, quotes and no-shows,
 * about requests and quotes that lapse, and gets reminders. A completed order
 * sends nothing.
 */
export function deliveryFor(type: string, facts: EventFacts): Delivery {
  const forBusiness = (at: Date | null) => (at ? formatWhen(at, BUSINESS_TIME_ZONE) : "time unknown");
  const forUser = (at: Date | null) => (at ? formatWhen(at, facts.userTimeZone) : "your booked time");
  const customer = facts.customerName ? ` — ${facts.customerName}` : "";
  // "AC Servicing", "Wash & Fold pickup", "Wiring visit".
  const step = facts.appointmentKind && facts.appointmentKind !== "job" ? ` ${facts.appointmentKind}` : "";
  const reason = facts.reason ? ` (${facts.reason})` : "";
  const { businessName, serviceName } = facts;

  switch (type) {
    case "order.confirmed":
      return { push: { title: "New booking", body: `${serviceName}${step}, ${forBusiness(facts.scheduledAt)}${customer}` } };
    case "order.requested":
      return {
        push: {
          title: facts.appointmentKind === "visit" ? "New quote request" : "New request",
          body: `${serviceName}${step}, ${forBusiness(facts.scheduledAt)}${customer}${
            facts.holdExpiresAt ? `. Accept or decline by ${forBusiness(facts.holdExpiresAt)}` : ""
          }`,
        },
      };
    case "order.accepted":
      return {
        message:
          facts.appointmentKind === "visit"
            ? `${businessName} confirmed they'll visit ${forUser(facts.scheduledAt)} to quote for ${serviceName}.`
            : `${businessName} confirmed your ${serviceName}, ${forUser(facts.scheduledAt)}.`,
      };
    case "order.declined":
      return {
        message: `Sorry, ${businessName} can't take your ${serviceName} request${reason}. Want me to find somewhere else?`,
        offerRebooking: true,
      };
    case "order.expired":
      return {
        push: { title: "Request expired", body: `${serviceName}${step}, ${forBusiness(facts.scheduledAt)}${customer}` },
        message: `${businessName} didn't confirm your ${serviceName} request in time, so it's been released. Want me to find somewhere else?`,
        offerRebooking: true,
      };
    case "order.rescheduled":
      return {
        push: {
          title: facts.needsApproval ? "Booking moved — needs your OK" : "Booking moved",
          body: `${serviceName}${customer}: ${forBusiness(facts.from)} → ${forBusiness(facts.to)}${
            facts.holdExpiresAt ? `. Accept or decline by ${forBusiness(facts.holdExpiresAt)}` : ""
          }`,
        },
      };
    case "order.cancelled_by_user":
      return { push: { title: "Booking cancelled", body: `${serviceName}${step}, ${forBusiness(facts.scheduledAt)}${customer}` } };
    case "order.cancelled_by_business":
      // §6: the user is told, and the agent offers to rebook.
      return {
        message: `Sorry, ${businessName} cancelled your ${serviceName} on ${forUser(facts.scheduledAt)}${reason}. Want me to find another time?`,
        offerRebooking: true,
      };
    case "order.no_show":
      return {
        message: `${businessName} marked your ${serviceName} on ${forUser(facts.scheduledAt)} as a no-show. If that's wrong, you can reach them on ${facts.businessPhone}.`,
      };
    case "order.final_price": {
      const units = facts.quantity !== null && facts.unitLabel ? ` for ${facts.quantity} ${facts.unitLabel}` : "";
      return { message: `${businessName} set the final price for your ${serviceName}: AED ${facts.amountAed}${units}.` };
    }
    case "quote.sent":
      return {
        message: `${businessName} quoted AED ${facts.amountAed} for ${serviceName}${
          facts.estDurationMin ? `, about ${duration(facts.estDurationMin)} of work` : ""
        }${facts.validUntil ? `, valid until ${forUser(facts.validUntil)}` : ""}. Open the booking to accept it and pick a time.`,
      };
    case "quote.accepted":
      return {
        push: {
          title: "Quote accepted",
          body: `${serviceName}${customer}: AED ${facts.amountAed}, job ${forBusiness(facts.scheduledAt)}`,
        },
      };
    case "quote.expired":
      return {
        push: { title: "Quote expired", body: `${serviceName}${customer}: AED ${facts.amountAed}` },
        message: `Your quote from ${businessName} for ${serviceName} (AED ${facts.amountAed}) has expired. Want me to find someone else?`,
        offerRebooking: true,
      };
    case "appointment.reminder": {
      const when = forUser(facts.scheduledAt);
      const at = facts.serviceAddress ? `, at ${facts.serviceAddress}` : "";
      if (facts.appointmentKind === "pickup") return { message: `Reminder: ${businessName} collects your ${serviceName} ${when}${at}.` };
      if (facts.appointmentKind === "delivery") return { message: `Reminder: ${businessName} brings back your ${serviceName} ${when}${at}.` };
      if (facts.appointmentKind === "visit") return { message: `Reminder: ${businessName} visits to quote for ${serviceName}, ${when}${at}.` };
      return { message: `Reminder: ${serviceName} with ${businessName}, ${when}${at}.` };
    }
    default:
      return {};
  }
}
