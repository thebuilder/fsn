/**
 * The fragment never reaches the server on its own, but analytics reports what
 * `location.href` says, and the fragment is now the directory you are standing in —
 * inside a local folder, that is a list of your own file names. Cutting it off here
 * keeps the promise the picker makes: nothing about a chosen folder leaves the machine.
 *
 * Nothing is lost by it. There is one page, and every address is a view of that page.
 */
export function stripFragment<T extends { url: string }>(event: T): T {
  return { ...event, url: event.url.split("#")[0] };
}
