/**
 * What the agent says. Written here rather than by the model: the model only
 * works out what a message means, and code decides and phrases the answer, so
 * replies are instant, predictable, and match what actually happened.
 */

import type { SearchView, SearchViewOption } from "../search-view.js";
import type { CatalogueCategory } from "./catalogue.js";
import type { NamedBusiness, UpcomingOrder } from "./lookups.js";
import { formatClock, formatWhen, formatWindow, toLocal, type WindowProblem } from "@personal-agent/core";

function price(option: SearchViewOption): string {
  const { pricingMode, unitLabel } = option.service;
  if (pricingMode === "quote") {
    return option.priceAed === null ? "priced after a visit" : `priced after a visit (visit AED ${option.priceAed})`;
  }
  if (pricingMode === "per_unit") {
    return `AED ${option.priceAed}/${unitLabel}${option.estimateAed === null ? "" : ` (about AED ${option.estimateAed})`}`;
  }
  return pricingMode === "from" ? `from AED ${option.priceAed}` : `AED ${option.priceAed}`;
}

const or = (labels: string[]) =>
  labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : (labels[0] ?? "");

/**
 * "12:00, 14:30 or 16:30", with the day added when the times span days. A
 * pickup shows when it comes back: "10:00 (back Sat 10:00)".
 */
function times(option: SearchViewOption, timeZone: string): string {
  const days = new Set(option.offeredSlots.map((slot) => toLocal(slot, timeZone).slice(0, 10)));
  return or(
    option.offeredSlots.map((slot, i) => {
      const label = days.size > 1 ? formatWhen(slot, timeZone) : formatClock(slot, timeZone);
      const back = option.laterSlots?.[i]?.at(-1);
      return back ? `${label} (back ${formatWhen(back, timeZone)})` : label;
    }),
  );
}

function optionLines(view: SearchView, timeZone: string): string {
  const names = view.options.map((option) => option.business.name);
  return view.options
    .map((option) => {
      // Two branches of one business need their address to tell them apart.
      const repeated = names.filter((name) => name === option.business.name).length > 1;
      const business = repeated ? `${option.business.name} (${option.business.address})` : option.business.name;
      const approval = option.service.confirmation === "request" ? ", they confirm each booking" : "";
      return `${option.rank}. ${business} — ${option.service.displayName}, ${price(option)}${approval}, ${option.distanceKm} km — ${times(option, timeZone)}`;
    })
    .join("\n");
}

const windowOf = (view: SearchView, timeZone: string) =>
  formatWindow(view.search.windowStart, view.search.windowEnd, timeZone);

// --- search results ---------------------------------------------------------

export function options(view: SearchView, serviceName: string, timeZone: string, prefix: string): string {
  const count = view.options.length === 1 ? "Here's 1 place" : `Here are ${view.options.length} places`;
  return `${prefix}${count} for ${serviceName}, ${windowOf(view, timeZone)}:\n${optionLines(view, timeZone)}\n\nPick a place and a time to book.`;
}

/** §7: nobody does it at all — a different message from "nothing free". */
export function nobodyOffers(serviceName: string, prefix: string): string {
  return `${prefix}No one on the app offers ${serviceName} near you yet.`;
}

/** §7: "3 places do this but nothing tomorrow afternoon, try Friday?" */
export function nothingFree(
  view: SearchView,
  matched: number,
  serviceName: string,
  businessName: string | null,
  timeZone: string,
  prefix: string,
): string {
  const who = businessName ?? (matched === 1 ? "1 place nearby does this" : `${matched} places nearby do ${serviceName}`);
  return businessName
    ? `${prefix}${who} has nothing free ${windowOf(view, timeZone)}. Want to try another time?`
    : `${prefix}${who}, but nothing is free ${windowOf(view, timeZone)}. Want to try another time?`;
}

// --- questions: one per message (§4) ----------------------------------------

export function askCategory(labels: string[]): string {
  return `Which do you need: ${labels.map((label, i) => `${i + 1}. ${label}`).join(" or ")}?`;
}

export function askBranch(typed: string, found: NamedBusiness[]): string {
  return `There's more than one ${typed}. Which one?\n${found.map((b, i) => `${i + 1}. ${b.name} — ${b.address}`).join("\n")}`;
}

export function askService(category: CatalogueCategory, askedBefore: boolean): string {
  const names = category.services.map((service) => service.name);
  return askedBefore
    ? `Which of these do you need: ${names.join(", ")}?`
    : `Which service do you need? For example: ${names.slice(0, 4).join(", ")}.`;
}

const WINDOW_PROBLEMS: Record<WindowProblem, string> = {
  unreadable: "I couldn't work out that time. ",
  ends_before_start: "I couldn't work out that time. ",
  in_past: "That time has already passed. ",
  too_long: "That's more than two weeks — could you narrow it down? ",
};

export function askTime(problem: WindowProblem | null): string {
  return `${problem ? WINDOW_PROBLEMS[problem] : ""}When would you like it? For example "tomorrow afternoon" or "Saturday at 10am".`;
}

export function askDetail(key: string): string {
  return `What's the ${key.replaceAll("_", " ")}?`;
}

export function askAddress(): string {
  return "What's the address they should come to?";
}

export function askQuantity(unitLabel: string): string {
  return `Roughly how many ${unitLabel === "item" ? "items" : unitLabel}? A guess is fine, or say you're not sure.`;
}

export function askDescription(): string {
  return "Briefly, what's the job? It helps them come prepared to quote.";
}

export function needsLocation(): string {
  return "I need to know where you are to find places nearby. Add your home address in Settings, or share your location, then ask again.";
}

export function unsupported(categories: CatalogueCategory[]): string {
  return `Sorry, I can't book that yet. I can help with: ${categories.map((c) => c.name).join(", ")}.`;
}

// --- direct mode (§4's four outcomes) ---------------------------------------

export function notOnApp(typed: string): string {
  return `${typed} isn't on the app yet, but I can find you somewhere else nearby. `;
}

export function doesNotOffer(businessName: string, serviceName: string, atCustomer: boolean): string {
  return `${businessName} doesn't offer ${serviceName}${atCustomer ? " at your place" : ""}, but I can find you somewhere else nearby. `;
}

// --- picking and booking ------------------------------------------------------

/**
 * What was booked: a booking, a request the business confirms, or a visit to
 * quote. A pickup says when it comes back.
 */
export function booked(
  option: SearchViewOption,
  slot: Date,
  laterSlots: Date[],
  status: "confirmed" | "requested",
  timeZone: string,
  overlaps: boolean,
): string {
  const { displayName, pricingMode, confirmation } = option.service;
  const when = formatWhen(slot, timeZone);
  const back = laterSlots.at(-1);
  const pickup = back ? `pickup ${when}, back ${formatWhen(back, timeZone)}` : when;
  const warning = overlaps ? " Heads up: you have another booking at that time." : "";
  const name = option.business.name;

  if (pricingMode === "quote") {
    return confirmation === "request" && status === "requested"
      ? `Asked ${name} to visit ${when} to quote for ${displayName}. They'll confirm within 2 hours; I'll let you know.${warning}`
      : `${name} will visit ${when} to quote for ${displayName}. You'll get the quote here to accept.${warning}`;
  }
  if (status === "requested") {
    return `Requested: ${displayName} with ${name}, ${pickup}, ${price(option)}. They'll confirm within 2 hours; I'll let you know.${warning}`;
  }
  return `Booked: ${displayName} with ${name}, ${pickup}, ${price(option)}.${warning}`;
}

export function whichOption(view: SearchView): string {
  return `Which place would you like? ${view.options.map((o) => `${o.rank}. ${o.business.name}`).join(", ")}.`;
}

export function whichTime(option: SearchViewOption, timeZone: string): string {
  return `Which time at ${option.business.name}: ${times(option, timeZone)}?`;
}

export function notOffered(option: SearchViewOption, timeZone: string): string {
  return `That time isn't one of ${option.business.name}'s options. It has ${times(option, timeZone)}.`;
}

/** §6: on a 409, a fresh list rather than starting over. */
export function slotGone(view: SearchView, timeZone: string): string {
  return view.options.length > 0
    ? `Sorry, that time was just taken. Here's a fresh list:\n${optionLines(view, timeZone)}`
    : `Sorry, that time was just taken, and nothing else is free ${windowOf(view, timeZone)}. Want to try another time?`;
}

export function listClosed(): string {
  return "That list isn't open any more. What would you like to book?";
}

export function nothingToPick(): string {
  return "There's nothing to pick from yet. What would you like to book?";
}

// --- existing bookings ----------------------------------------------------------

function describeOrder(order: UpcomingOrder, timeZone: string): string {
  const what = `${order.service.displayName} with ${order.business.name}`;
  if (order.status === "quoted" && order.quote) return `${what}, quoted AED ${order.quote.amountAed}`;
  const next = order.appointments.find((a) => a.status === "held" || a.status === "confirmed");
  const when = next ? `, ${formatWhen(next.scheduledAt, timeZone)}` : "";
  return `${what}${when}${order.status === "requested" ? " (waiting for them)" : ""}`;
}

export function noBookings(): string {
  return "You don't have any upcoming bookings.";
}

export function whichBooking(orders: UpcomingOrder[], timeZone: string): string {
  return `Which booking?\n${orders.map((order, i) => `${i + 1}. ${describeOrder(order, timeZone)}`).join("\n")}`;
}

/**
 * The agent finds the booking; the user confirms on its card, which calls the
 * cancel and reschedule endpoints. A misread message never cancels anything.
 */
export function bookingCard(order: UpcomingOrder, action: "cancel" | "reschedule" | null, timeZone: string): string {
  const next =
    action === "cancel"
      ? "Tap Cancel on it to confirm."
      : action === "reschedule"
        ? "Tap Reschedule on it to pick a new time."
        : "You can cancel or reschedule it from there.";
  return `Here's your booking: ${describeOrder(order, timeZone)}. ${next}`;
}

export function stopped(hadSearch: boolean): string {
  return hadSearch ? "OK, I've stopped that search." : "OK.";
}

export function fallback(): string {
  return "I can find and book local services for you. What do you need?";
}
