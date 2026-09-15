'use client';

import { useActionState } from 'react';
import { bookRoom, type BookingState } from './actions';

const initialState: BookingState = { status: 'idle', message: '' };

export function BookingForm() {
  const [state, action, pending] = useActionState(bookRoom, initialState);

  return (
    <form action={action} className="booking-form">
      <label>
        Room
        <select name="room" defaultValue="Room A">
          <option>Room A</option>
          <option>Room B</option>
        </select>
      </label>
      <label>
        Guest
        <input name="guest" required maxLength={60} placeholder="Ada" />
      </label>
      <label>
        From
        <input name="from" type="time" required defaultValue="10:00" />
      </label>
      <label>
        To
        <input name="to" type="time" required defaultValue="11:00" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Booking…' : 'Book'}
      </button>
      {state.message !== '' && (
        <p className={`message ${state.status}`} role="status">
          {state.message}
        </p>
      )}
    </form>
  );
}
