/**
 * Gemini Web session pages shared by the offline suites (gemini-web-fallback, gemini-web-rotation),
 * so what counts as "signed in" is written once, from the client's own marker.
 */
import { SIGNED_IN_MARKER } from "../src/gemini-web-client";

/** A session page rendered for a signed-in account: an action token plus the signed-in marker. */
export const SIGNED_IN_PAGE = `<script>{"SNlM0e":"tok-1","cfb2h":"bl-1","FdrFJe":"sid-1","${SIGNED_IN_MARKER}":"signed-in-user-marker"}</script>`;

/**
 * What gemini.google.com serves a signed-out visitor (no cookie, a bad one, an expired one):
 * HTTP 200 with an action token, so it used to look like a working session and was answered
 * anonymously. It has no signed-in marker.
 */
export const ANONYMOUS_PAGE = '<script>{"thykhd":"anon-tok","cfb2h":"bl-1","FdrFJe":"sid-1"}</script>';

/** A signed-in page carrying only the newer action token (SNlM0e is gone from live pages). */
export const SIGNED_IN_THYKHD_PAGE = `<script>{"thykhd":"tok","cfb2h":"bl","FdrFJe":"sid","${SIGNED_IN_MARKER}":"marker"}</script>`;
