# Content-addressed store

An HTTP service that stores text by its SHA-256 hash, with named tags that point at stored
text. Data is kept in SQLite and survives a restart.

## Running

- The program reads the port from `PORT` and serves HTTP on `127.0.0.1:$PORT` (not every
  interface).
- `DB` is the path of the SQLite database file, made (with its tables) if it doesn't exist.
  Stopping the program and starting it again on the same file keeps everything.
- Bodies of stored text are plain text (UTF-8); every other response body is JSON. An error's
  body is `{"error": "<message>"}`, with any message that helps.
- Write the program as at least three source files (modules, packages, or whatever the
  language calls them), split as you see fit: for example storage, hashing and HTTP.

## Blobs

A blob is a stored text. Its id is the SHA-256 hash of its bytes (as UTF-8), as 64 lowercase
hex digits. Its size is its length in bytes.

| Request                    | Answer                                                         |
| -------------------------- | -------------------------------------------------------------- |
| `PUT /blobs`               | the body is the text to store (it may be empty): 201 and `{"id": "...", "size": 5, "created": true}`; if that text is already stored, 200 and the same with `"created": false` |
| `GET /blobs/{id}`          | 200 and the text, exactly as stored, `content-type: text/plain; charset=utf-8` |
| `GET /blobs/{id}?encoding=base64` | 200 and the text's bytes in standard base64 (with `=` padding), as plain text. Any other `encoding`: 400 |
| `GET /blobs/{id}/meta`     | 200, `{"id": "...", "size": 5, "tags": ["latest", "v1"]}`: the tags pointing at it, in name order |
| `DELETE /blobs/{id}`       | 204, no body; 409 if any tag points at it                      |
| `GET /blobs`               | 200, `{"blobs": [{"id": "...", "size": 5}, ...]}`, every blob, by id |

An id in a path that isn't 64 lowercase hex digits: 400. A well-formed id that names nothing:
404.

## Tags

A tag is a name pointing at one blob. Names are 1 to 64 characters from `a-z`, `0-9`, `-`, `.`
and `_`.

| Request              | Answer                                                         |
| -------------------- | -------------------------------------------------------------- |
| `PUT /tags/{name}`   | body `{"id": "..."}`: points the tag at that blob (made, or moved if it existed); 200 and `{"name": "v1", "id": "..."}`. 404 if the blob doesn't exist; 400 for a bad name, a bad id, or a body that isn't that JSON |
| `GET /tags/{name}`   | 200 and `{"name": "v1", "id": "..."}`; 404 if there is no such tag |
| `DELETE /tags/{name}`| 204; 404 if there is no such tag                               |
| `GET /tags`          | 200, `{"tags": [{"name": "v1", "id": "..."}, ...]}`, by name   |

A path that matches no endpoint: 404. A known path with the wrong method: 405.

## Tests

Write tests in the language's own way for each rule above. They are yours; separate tests,
which you don't see, start the program and send it requests.
