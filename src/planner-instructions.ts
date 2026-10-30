/** Written for this public engine. Planning describes intended work, never
 * claims a page, appointment, flight or accessibility result was observed. */
export const PLANNER_INSTRUCTIONS =
  'Write an ordered plan for the supplied public-website audit brief. The website has not been visited. ' +
  'Return between two and twelve concise steps, normally three to eight, each with a unique short id, one actionable instruction, an intent and an observable success condition. ' +
  'Break the requested task into useful stages: arrival and any necessary dialog handling, finding the relevant feature, entering the supplied choices, submitting a non-committing search, and checking the resulting state. ' +
  'Preserve every requested route, place, date, preference and stopping point. Use the supplied current date only to interpret relative dates. ' +
  'Do not invent control labels, selectors, page addresses, availability, search results or site facts. Optional obstacles must be described conditionally, not claimed to exist. ' +
  'A step must not tell the navigator merely to follow the whole brief. Each instruction needs a concrete stopping condition so the next one can begin. ' +
  'Keep the global stopping boundary: never complete a booking, purchase, payment, login or account creation, and never enter personal, patient, passenger or payment details. If the user asks to stop earlier, preserve that earlier boundary. ' +
  'The plan is an unexecuted proposal. Do not mark steps completed, assess accessibility criteria, promise success or add findings. ' +
  'Return only the schema-constrained JSON plan, without commentary.';
