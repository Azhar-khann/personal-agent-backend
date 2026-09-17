import { getDb, schema } from "@personal-agent/core";
import { and, desc, eq, lt } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";

import { runTurn } from "../agent/turn.js";
import { currentUser } from "../auth.js";
import type { ApiEnv } from "../env.js";
import { HttpError, parse, uuidParam } from "../http.js";
import { loadOrders } from "../orders.js";
import { searchView } from "../search-view.js";
import { dateTime } from "../validation.js";

const { conversations, messages, orders } = schema;

type MessageRow = typeof messages.$inferSelect;

/** Messages as the frontend renders them: the text, plus what to show with it. */
function toMessage(message: MessageRow) {
  const metadata = message.metadata as Record<string, unknown>;
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    // "options" → option cards for searchId; "booking" → a card for orderId; ...
    kind: metadata["kind"] ?? null,
    searchId: metadata["search_id"] ?? null,
    orderId: metadata["order_id"] ?? null,
    bookingAction: metadata["booking_action"] ?? null,
  };
}

const MessageBody = z
  .object({
    /** Omit to start a new conversation. */
    conversationId: z.string().uuid().optional(),
    content: z.string().trim().min(1).max(2000),
    /** The browser's location, when shared; otherwise searches start from home. */
    location: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .strict()
      .optional(),
  })
  .strict();

const PageQuery = z
  .object({
    before: dateTime.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export function chatRouter(env: ApiEnv) {
  const router = Router();

  /**
   * POST /api/chat/messages — the main endpoint (§8). Returns the user's
   * message and the reply, with the search or order the reply is about.
   */
  router.post("/messages", async (req, res) => {
    const user = currentUser(req);
    const body = parse(MessageBody, req.body ?? {});

    const turn = await runTurn({
      env,
      user,
      conversationId: body.conversationId ?? null,
      content: body.content,
      location: body.location ?? null,
    });

    const [search, order] = await Promise.all([
      turn.searchId ? searchView(turn.searchId, user.id) : null,
      turn.orderId ? loadOrders(eq(orders.id, turn.orderId)).then((rows) => rows[0] ?? null) : null,
    ]);

    res.status(201).json({
      conversationId: turn.conversationId,
      messages: [toMessage(turn.userMessage), toMessage(turn.reply)],
      search,
      order,
    });
  });

  /** GET /api/chat/conversations — not in §8, but /chat/[id] needs a way to find older chats. */
  router.get("/conversations", async (req, res) => {
    const rows = await getDb()
      .select({ id: conversations.id, status: conversations.status, createdAt: conversations.createdAt, updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(eq(conversations.userId, currentUser(req).id))
      .orderBy(desc(conversations.updatedAt))
      .limit(50);
    res.json({ conversations: rows });
  });

  /**
   * GET /api/chat/conversations/:id/messages?before=&limit= — history, paged
   * backwards for scrolling up. Pass the returned nextBefore to load older.
   */
  router.get("/conversations/:id/messages", async (req, res) => {
    const conversationId = uuidParam(req.params.id);
    const { before, limit } = parse(PageQuery, req.query);
    const db = getDb();

    const [owned] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, currentUser(req).id)));
    if (!owned) throw new HttpError(404, "conversation_not_found", "No such conversation");

    const newestFirst = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), before ? lt(messages.createdAt, before) : undefined))
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1);

    const page = newestFirst.slice(0, limit);
    res.json({
      messages: page.reverse().map(toMessage),
      nextBefore: newestFirst.length > limit ? page[0]!.createdAt : null,
    });
  });

  return router;
}
