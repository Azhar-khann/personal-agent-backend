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
  if (option.priceAed === null) return "price on quote";
  return option.service.pricingMode === "from" ? `from AED ${option.priceAed}` : `AED ${option.priceAed}`;
}

/** "12:00, 14:30 or 16:30", with the day added when the times span days. */
function times(option: SearchViewOption, timeZone: string): string {
  const days = new Set(option.offeredSlots.map((slot) => toLocal(slot, timeZone).slice(0, 10)));
  const labels = option.offeredSlots.map((slot) =>
    days.size > 1 ? formatWhen(slot, timeZone) : formatClock(slot, timeZone),
  );
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : (labels[0] ?? "");
}

function optionLines(view: SearchView, timeZone: string): string {
  const names = view.options.map((option) => option.business.name);
  return view.options
    .map((option) => {
      // Two branches of one business need their address to tell them apart.
      const repeated = names.filter((name) => name === option.business.name).length > 1;
      const business = repeated ? `${option.business.name} (${option.business.address})` : option.business.name;
      return `${option.rank}. ${business} — ${option.service.displayName}, ${price(option)}, ${option.distanceKm} km — ${times(option, timeZone)}`;
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

export function booked(option: SearchViewOption, slot: Date, timeZone: string, overlaps: boolean): string {
  return `Booked: ${option.service.displayName} with ${option.business.name}, ${formatWhen(slot, timeZone)}, ${price(option)}.${overlaps ? " Heads up: you have another booking at that time." : ""}`;
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

const describeOrder = (order: UpcomingOrder, timeZone: string) =>
  `${order.service.displayName} with ${order.business.name}, ${formatWhen(order.appointments[0]!.scheduledAt, timeZone)}`;

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
