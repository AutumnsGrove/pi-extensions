/**
 * Hidden markers pi-review writes into GitHub content.
 *
 * They are HTML comments, invisible in the rendered UI, and let a later run
 * find its own previous work without a database: the review marker locates the
 * last reviewed commit (incremental re-review), the summary marker locates the
 * one sticky issue comment that gets updated in place.
 */

/** Appended to every posted review body. */
export const REVIEW_MARKER = "<!-- pi-review:review -->";

/** Present in the sticky summary issue comment. */
export const STICKY_MARKER = "<!-- pi-review:summary -->";
