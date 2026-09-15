import { asc } from 'drizzle-orm';
import { getDb } from '../src/db/client';
import { bookings } from '../src/db/schema';
import { BookingForm } from './booking-form';
import { RaceButton } from './race-button';

export const dynamic = 'force-dynamic';

const clock = (date: Date) => date.toISOString().slice(11, 16);

export default async function Home() {
  const rows = await getDb().select().from(bookings).orderBy(asc(bookings.room), asc(bookings.startsAt));

  return (
    <main>
      <h1>Room bookings</h1>
      <p className="lead">
        Every booking goes through <code>catchOverlap()</code> from <code>drizzle-exclude</code>. Whether two bookings
        clash is decided by an exclusion constraint in PostgreSQL, not by this app, so it holds even when requests arrive
        at the same instant. All times are UTC on 1 June 2026.
      </p>

      <section>
        <h2>Book a room</h2>
        <BookingForm />
      </section>

      <section>
        <h2>Ten guests, one slot, same instant</h2>
        <p>
          Sends ten bookings for the next free hour in the race room simultaneously. A check in application code would
          let several through; the constraint lets exactly one.
        </p>
        <RaceButton />
      </section>

      <section>
        <h2>Bookings</h2>
        {rows.length === 0 ? (
          <p>No bookings yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Guest</th>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.room}</td>
                  <td>{row.guest}</td>
                  <td>{clock(row.startsAt)}</td>
                  <td>{clock(row.endsAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
