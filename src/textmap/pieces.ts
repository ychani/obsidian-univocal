/**
 * Bookkeeping shared by the `<mark>` highlight fallback and the reading-view
 * text map.
 *
 * The fallback swaps a text node for "pieces" (plain text nodes and `<mark>`
 * elements wrapping text nodes) and later puts the original node back. While
 * pieces are in the DOM, the text map must still see the ORIGINAL node, so
 * that re-walking (extend/remap, often triggered by a MutationObserver seeing
 * our own wrapping) neither changes the text nor points entries at pieces.
 */

export interface PieceOrigin {
	/** The original text node the piece was cut from. */
	node: Text;
	/** Offset of the piece's first unit inside the original node. */
	base: number;
}

const pieceOrigin = new WeakMap<Text, PieceOrigin>();
const firstPiece = new WeakMap<Text, Node>();
const fallbackElements = new WeakSet<Node>();
/** Every original ever wrapped (kept after unwrapping, so the restore mutation is recognised too). */
const wrappedOriginals = new WeakSet<Text>();

/** Record that `piece` (a text node) holds `original.data.slice(base, …)`. */
export function registerPiece(piece: Text, original: Text, base: number): void {
	pieceOrigin.set(piece, { node: original, base });
}

/** Record the first DOM node (text or `<mark>`) that stands in for `original`. */
export function registerWrap(original: Text, first: Node): void {
	firstPiece.set(original, first);
	wrappedOriginals.add(original);
}

export function unregisterWrap(original: Text): void {
	firstPiece.delete(original);
}

/** Mark an element created by the fallback (a `<mark>`). */
export function registerFallbackElement(el: Node): void {
	fallbackElements.add(el);
}

export function originOf(node: Node): PieceOrigin | undefined {
	return node.nodeType === 3 ? pieceOrigin.get(node as Text) : undefined;
}

/** Map a DOM point inside a piece back to the original node. */
export function originalPoint(node: Node, offset: number): { node: Node; offset: number } {
	const o = originOf(node);
	return o ? { node: o.node, offset: offset + o.base } : { node, offset };
}

/** A node that is in the document for `original`: itself, or its first piece while wrapped. */
export function liveNodeFor(original: Text): Node {
	if (original.parentNode) return original;
	const p = firstPiece.get(original);
	return p && p.parentNode ? p : original;
}

/** True for nodes the fallback creates, wraps or restores — mutations of only these are not content changes. */
export function isFallbackNode(node: Node): boolean {
	if (fallbackElements.has(node)) return true;
	if (node.nodeType === 3) return pieceOrigin.has(node as Text) || wrappedOriginals.has(node as Text);
	return false;
}
