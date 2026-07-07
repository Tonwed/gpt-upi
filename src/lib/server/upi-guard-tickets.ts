import { randomUUID } from "crypto";
import { encryptSessionCredential, hashSessionCredential } from "@/lib/server/credential-vault";

const GUARD_CREATE_TICKET_TTL_MS = 15 * 60 * 1000;
const MAX_TICKETS = 2_000;

type GuardCreateTicket = {
  token: string;
  credentialEncrypted: string;
  credentialHash: string;
  createdAt: number;
  expiresAt: number;
};

type GuardTicketGlobal = typeof globalThis & {
  __upiGuardCreateTickets?: Map<string, GuardCreateTicket>;
};

const tickets = (globalThis as GuardTicketGlobal).__upiGuardCreateTickets ?? new Map<string, GuardCreateTicket>();
(globalThis as GuardTicketGlobal).__upiGuardCreateTickets = tickets;

export function cleanupGuardCreateTickets() {
  const now = Date.now();
  for (const [token, ticket] of tickets.entries()) {
    if (ticket.expiresAt <= now) tickets.delete(token);
  }

  while (tickets.size > MAX_TICKETS) {
    const oldest = tickets.keys().next().value as string | undefined;
    if (!oldest) break;
    tickets.delete(oldest);
  }
}

export function createGuardCreateTicket(credential: string) {
  cleanupGuardCreateTickets();
  const now = Date.now();
  const token = randomUUID();
  tickets.set(token, {
    token,
    credentialEncrypted: encryptSessionCredential(credential),
    credentialHash: hashSessionCredential(credential),
    createdAt: now,
    expiresAt: now + GUARD_CREATE_TICKET_TTL_MS,
  });
  return token;
}

export function consumeGuardCreateTicket(token: string) {
  cleanupGuardCreateTickets();
  const ticket = tickets.get(token);
  if (!ticket || ticket.expiresAt <= Date.now()) return null;
  tickets.delete(token);
  return {
    credentialEncrypted: ticket.credentialEncrypted,
    credentialHash: ticket.credentialHash,
  };
}
