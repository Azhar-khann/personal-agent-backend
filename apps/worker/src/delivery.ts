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
  /** The appointment the event is about, if any. */
  scheduledAt: Date | null;
  /** For a reschedule. */
  from: Date | null;
  to: Date | null;
  serviceAddress: string | null;
  reason: string | null;
  userTimeZone: string;
};

export type Delivery = {
  /** A browser push to the business's staff. */
  push?: { title: string; body: string };
  /** An assistant message in the user's conversation. */
  message?: string;
  /** Prefill the conversation so "yes, tomorrow" searches for the same service again. */
  offerRebooking?: boolean;
};

/**
 * Nobody is told about what they did themselves: a business hears about the
 * user's bookings, moves and cancellations; the user hears about the business's
 * cancellations and no-shows, and gets reminders. A completed order sends
 * nothing.
 */
export function deliveryFor(type: string, facts: EventFacts): Delivery {
  const forBusiness = (at: Date | null) => (at ? formatWhen(at, BUSINESS_TIME_ZONE) : "time unknown");
  const forUser = (at: Date | null) => (at ? formatWhen(at, facts.userTimeZone) : "your booked time");
  const customer = facts.customerName ? ` — ${facts.customerName}` : "";

  switch (type) {
    case "order.confirmed":
      return { push: { title: "New booking", body: `${facts.serviceName}, ${forBusiness(facts.scheduledAt)}${customer}` } };
    case "order.rescheduled":
      return {
        push: {
          title: "Booking moved",
          body: `${facts.serviceName}${customer}: ${forBusiness(facts.from)} → ${forBusiness(facts.to)}`,
        },
      };
    case "order.cancelled_by_user":
      return { push: { title: "Booking cancelled", body: `${facts.serviceName}, ${forBusiness(facts.scheduledAt)}${customer}` } };
    case "order.cancelled_by_business":
      // §6: the user is told, and the agent offers to rebook.
      return {
        message: `Sorry, ${facts.businessName} cancelled your ${facts.serviceName} on ${forUser(facts.scheduledAt)}${
          facts.reason ? ` (${facts.reason})` : ""
        }. Want me to find another time?`,
        offerRebooking: true,
      };
    case "order.no_show":
      return {
        message: `${facts.businessName} marked your ${facts.serviceName} on ${forUser(facts.scheduledAt)} as a no-show. If that's wrong, you can reach them on ${facts.businessPhone}.`,
      };
    case "appointment.reminder":
      return {
        message: `Reminder: ${facts.serviceName} with ${facts.businessName}, ${forUser(facts.scheduledAt)}${
          facts.serviceAddress ? `, at ${facts.serviceAddress}` : ""
        }.`,
      };
    default:
      return {};
  }
}
