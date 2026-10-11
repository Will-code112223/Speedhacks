/**
 * The server answers 404 both for an unknown case and for a case owned by
 * another browser session (ownership is a session cookie), so the message
 * names both without guessing which one happened.
 */
export const CASE_NOT_FOUND_MESSAGE = "This case was not found for this browser session.";
