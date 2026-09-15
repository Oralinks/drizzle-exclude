'use server';

import { catchOverlap } from 'drizzle-exclude';
import { desc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { getDb } from '../src/db/client';
import { bookings } from '../src/db/schema';

export interface BookingState {
  status: 'idle' | 'booked' | 'taken' | 'busy' | 'invalid';
  message: string;
}

export interface RaceState {
  ran: boolean;
  slot: string;
  booked: number;
  taken: number;
  busy: number;
}

// Every booking in the demo is on one day, in UTC, to keep the page simple.
const DEMO_DAY = '2026-06-01';
const ROOMS = ['Room A', 'Room B'];
const RACE_ROOM = 'Race room';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const clock = (date: Date) => date.toISOString().slice(11, 16);

export async function bookRoom(_previous: BookingState, form: FormData): Promise<BookingState> {
  const room = String(form.get('room'));
  const guest = String(form.get('guest')).trim();
  const from = String(form.get('from'));
  const to = String(form.get('to'));

  if (!ROOMS.includes(room) || guest === '' || guest.length > 60 || !TIME.test(from) || !TIME.test(to) || from >= to) {
    return { status: 'invalid', message: 'Pick a room, enter a name, and choose an end time after the start time.' };
  }

  const result = await catchOverlap(
    getDb()
      .insert(bookings)
      .values({
        room,
        guest,
        startsAt: new Date(`${DEMO_DAY}T${from}:00Z`),
        endsAt: new Date(`${DEMO_DAY}T${to}:00Z`),
      }),
  );

  if (result.ok) {
    revalidatePath('/');
    return { status: 'booked', message: `Booked ${room} for ${guest}, ${from}–${to}.` };
  }
  switch (result.reason) {
    case 'overlap':
      return { status: 'taken', message: `${room} is already booked for part of ${from}–${to}.` };
    case 'contention':
      return { status: 'busy', message: 'Someone else was booking at the same moment. Please try again.' };
  }
}

/** Ten guests try to book the same hour in the same room at the same instant. */
export async function raceTenGuests(_previous: RaceState): Promise<RaceState> {
  const db = getDb();
  const [latest] = await db
    .select({ endsAt: bookings.endsAt })
    .from(bookings)
    .where(eq(bookings.room, RACE_ROOM))
    .orderBy(desc(bookings.endsAt))
    .limit(1);
  const startsAt = latest?.endsAt ?? new Date(`${DEMO_DAY}T00:00:00Z`);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      catchOverlap(
        db.insert(bookings).values({ room: RACE_ROOM, guest: `Guest ${String(index + 1)}`, startsAt, endsAt }),
      ),
    ),
  );

  revalidatePath('/');
  return {
    ran: true,
    slot: `${clock(startsAt)}–${clock(endsAt)}`,
    booked: results.filter((result) => result.ok).length,
    taken: results.filter((result) => !result.ok && result.reason === 'overlap').length,
    busy: results.filter((result) => !result.ok && result.reason === 'contention').length,
  };
}
