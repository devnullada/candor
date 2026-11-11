# Bookings API

A JSON-over-HTTP service that books meeting rooms by the hour, kept in SQLite.

## Running

- The program reads the port from the `PORT` environment variable and serves HTTP on
  `127.0.0.1:$PORT` (not every interface).
- The data is in SQLite, in memory unless `DB` names a file. A fresh start has no rooms.
- Every response body is JSON; an error's body is `{"error": "<message>"}`, with any message
  that helps.

## Endpoints

| Request                     | Body                               | Success                     |
| --------------------------- | ---------------------------------- | --------------------------- |
| `POST /rooms`               | `{"name": "Fjord"}`                | 201, `{"id": 1, "name": "Fjord"}` |
| `GET /rooms`                |                                    | 200, every room by id       |
| `POST /bookings`            | `{"room": 1, "start": 9, "end": 11}` | 201, `{"id": 1, "room": 1, "start": 9, "end": 11}` |
| `GET /rooms/{id}/bookings`  |                                    | 200, the room's bookings by start |
| `DELETE /bookings/{id}`     |                                    | 204, no body                |

Ids are integers given out from 1, in order.

## Rules

- A room's `name` is trimmed and must not be empty: 400 otherwise.
- Hours are integers from 0 to 24; a booking is the half-open range `[start, end)`, so 9–11 and
  11–13 don't overlap. `start` must be before `end`. Either rule broken: 400.
- A booking for a room that doesn't exist: 404.
- A booking that overlaps another booking of the same room: 409. Requests arrive in parallel,
  so the overlap check and the insert must be one transaction: of many requests for the same
  slot at once, exactly one succeeds.
- A body that isn't JSON, or lacks a field, or has a field of the wrong type: 400.
- An id in a path that names nothing (including one that isn't an integer): 404.
- A path that matches no endpoint: 404. A known path with the wrong method: 405.
- A database failure: 500.

## Tests

Write tests in the language's own way for each rule above. They are yours; separate tests,
which you don't see, start the program and send it requests.
