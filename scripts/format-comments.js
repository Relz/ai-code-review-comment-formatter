// Content script for AI Code Review Comment Formatter
// Injected into web pages to interact with code review comments

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const CONFIG = {
    /** CSS selectors that identify comment body elements on supported platforms. */
    commentSelectors: [
      '.comment-body',
      '.review-comment .body',
      '.note-body',
      '.comment-content',
    ],
    /** Icons that appear in severity headers of AI-generated reviews. */
    severityIcons: ['🔴', '🟠', '🟡', '🔵', '⚠️'],
    /** Labels used to locate structured sections inside a review comment. */
    sectionLabels: {
      issue: '🧐 Issue',
      suggestion: '💡 Suggestion',
      context: '📝 Context',
    },
    /** Dataset key used to mark already-formatted comments. */
    formattedKey: 'aiFormatted',
    /** Debounce delay (ms) for the MutationObserver callback. */
    debounceMs: 500,
    /** Set to true to enable console logging. */
    debug: false,
  };

  // ---------------------------------------------------------------------------
  // Injected Styles
  // ---------------------------------------------------------------------------

  const STYLES = `
    details.ai-review-details {
      border-radius: 6px;
    }

    details.ai-review-details > summary {
      cursor: pointer;
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 6px;
      list-style: none;
      transition: background-color 0.15s ease;
    }

    details.ai-review-details > summary::-webkit-details-marker,
    details.ai-review-details > summary::marker {
      display: none;
      content: "";
    }

    details.ai-review-details > summary:hover {
      background-color: rgba(128, 128, 128, 0.1);
    }

    details.ai-review-details[open] > summary::before {
      transform: rotate(90deg);
    }

    details.ai-review-details > summary .ai-expand-hint {
      margin-left: auto;
      font-size: 1em;
      color: #888;
      font-weight: 400;
      transition: transform 0.15s ease;
    }

    details.ai-review-details[open] > summary .ai-expand-hint {
      transform: rotate(90deg);
    }

  `;

  /**
   * Inject the extension's stylesheet into the page (once).
   */
  function injectStyles() {
    if (document.getElementById('ai-review-formatter-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-review-formatter-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  injectStyles();

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Log a message to the console when debug mode is enabled.
   * @param {string} msg
   */
  function log(msg) {
    if (CONFIG.debug) {
      console.log(`AI Code Review Comment Formatter: ${msg}`);
    }
  }

  /**
   * Append cloned copies of the provided nodes to `parent`, skipping any
   * `null` / `undefined` values.
   * @param {HTMLElement} parent
   * @param  {...(HTMLElement|null|undefined)} nodes
   */
  function appendClonedIfPresent(parent, ...nodes) {
    for (const node of nodes) {
      if (node) {
        parent.appendChild(node.cloneNode(true));
      }
    }
  }

  /**
   * Given a list of elements that may contain ancestors and descendants of each
   * other, return only the *innermost* elements — i.e. those that do not
   * contain any other element from the list.
   *
   * This prevents double-processing when multiple selectors match both a parent
   * and its descendant (e.g. `.comment-content > .comment-body`).
   *
   * @param {HTMLElement[]} elements
   * @returns {HTMLElement[]}
   */
  function filterInnermostElements(elements) {
    return elements.filter(
      (el) => !elements.some((other) => other !== el && el.contains(other)),
    );
  }

  // ---------------------------------------------------------------------------
  // Comment detection helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether `element` is an AI-generated review comment by looking for
   * an `<h3>` whose text contains both "Severity:" and a known severity icon.
   * @param {HTMLElement} element
   * @returns {boolean}
   */
  function isAIReviewComment(element) {
    const h3 = element.querySelector('h3');
    if (!h3) return false;
    const text = h3.textContent ?? '';
    return (
      text.includes('Severity:') &&
      CONFIG.severityIcons.some((icon) => text.includes(icon))
    );
  }

  /**
   * Walk forward through the next element siblings of `startNode` and return
   * the first `<blockquote>`, or `null` if a section boundary (an `<hr>` or
   * another section header `<strong>`) is reached first.
   * @param {Element} startNode
   * @returns {HTMLElement|null}
   */
  function findNextBlockquote(startNode) {
    let sibling = startNode.nextElementSibling;
    while (sibling) {
      if (sibling.tagName === 'BLOCKQUOTE') return sibling;
      if (sibling.tagName === 'HR' || sibling.querySelector('strong')) break;
      sibling = sibling.nextElementSibling;
    }
    return null;
  }

  /**
   * Extract a labeled section (bold header + following blockquote) from a
   * comment element.
   *
   * Looks for a `<strong>` whose text includes `label`, then walks forward
   * from its block-level parent to locate the associated `<blockquote>`.
   *
   * @param {HTMLElement} element - The comment DOM element.
   * @param {string} label - The label text to search for (e.g. "🧐 Issue").
   * @returns {{ header: HTMLElement|null, blockquote: HTMLElement|null }}
   */
  function extractSection(element, label) {
    for (const strong of element.querySelectorAll('strong')) {
      if (!strong.textContent.includes(label)) continue;

      // Determine the block-level ancestor to start the sibling walk from.
      // If the <strong> is a direct child of the comment root, use it;
      // otherwise use its parentElement (typically a <p>).
      const anchor = strong.parentElement === element ? strong : strong.parentElement;
      const blockquote = findNextBlockquote(anchor);
      return { header: anchor, blockquote };
    }
    return { header: null, blockquote: null };
  }

  // ---------------------------------------------------------------------------
  // Part extraction
  // ---------------------------------------------------------------------------

  /**
   * @typedef {Object} CommentParts
   * @property {HTMLElement|null} severityH3
   * @property {HTMLElement|null} filePathEl
   * @property {{ header: HTMLElement|null, blockquote: HTMLElement|null }} issue
   * @property {{ header: HTMLElement|null, blockquote: HTMLElement|null }} suggestion
   * @property {{ header: HTMLElement|null, blockquote: HTMLElement|null }} context
   */

  /**
   * Extract the structured parts of an AI review comment from the DOM.
   * @param {HTMLElement} element
   * @returns {CommentParts}
   */
  function extractCommentParts(element) {
    // Severity header
    const severityH3 = element.querySelector('h3');

    // File path — the first block-level element whose *direct* text nodes contain 📂,
    // excluding any node inside an <h3> or <details>.
    let filePathEl = null;
    for (const child of element.querySelectorAll('div.paragraph, p')) {
      const hasDirectFolderIcon = Array.from(child.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent.includes('📂'),
      );
      if (hasDirectFolderIcon && !child.closest('h3') && !child.closest('details')) {
        filePathEl = child;
        break;
      }
    }

    const { sectionLabels } = CONFIG;
    return {
      severityH3,
      filePathEl,
      issue: extractSection(element, sectionLabels.issue),
      suggestion: extractSection(element, sectionLabels.suggestion),
      context: extractSection(element, sectionLabels.context),
    };
  }

  // ---------------------------------------------------------------------------
  // Severity badge injection into comment header
  // ---------------------------------------------------------------------------

  /**
   * Find the `.comment-header` associated with a comment body element and
   * inject the severity information between `.comment-header-primary-actions`
   * and `.comment-header-secondary-actions`.
   *
   * @param {HTMLElement} commentBodyEl - The comment body DOM element.
   * @param {HTMLElement} severityH3 - The `<h3>` containing severity info.
   */
  function injectSeverityIntoHeader(commentBodyEl, severityH3) {
    if (!severityH3) return;

    // Walk up from the comment body to find the nearest .comment-header
    let container = commentBodyEl.closest('.comment');
    if (!container) {
      // Fallback: walk up until we find something that contains .comment-header
      container = commentBodyEl.parentElement;
      while (container && !container.querySelector('.comment-header')) {
        container = container.parentElement;
      }
    }
    if (!container) return;

    const header = container.querySelector('.comment-header');
    if (!header) return;

    const headerText = header.querySelector('.comment-header-text');
    if (!headerText) return;

    // Avoid duplicate injection
    if (header.querySelector('.ai-severity-badge')) return;

    const badge = document.createElement('div');
    badge.className = 'ai-severity-badge';
    badge.style.cssText =
      'display: flex; align-items: center; padding: 2px 8px; font-weight: 600; font-size: 14px;';
    badge.innerHTML = severityH3.innerHTML;

    headerText.insertAdjacentElement('afterend', badge);
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  /**
   * Build the formatted `<details>` element from extracted comment parts.
   *
   * Layout:
   *   <summary>  → suggestion text
   *   <details>  → hr, file path, hr, issue section, context section
   *
   * (Severity is now injected into the comment header, not the summary.)
   *
   * @param {CommentParts} parts
   * @returns {HTMLDetailsElement}
   */
  function buildFormattedDetails(parts) {
    const details = document.createElement('details');
    details.className = 'ai-review-details';
    const summary = document.createElement('summary');

    // --- Summary: suggestion excerpt (severity moved to comment header) ---
    if (parts.suggestion.blockquote) {
      const inner = parts.suggestion.blockquote.querySelector('.paragraph, p');
      if (inner) {
        const wrapper = document.createElement('div');
        wrapper.className = 'paragraph';
        wrapper.innerHTML = inner.innerHTML;
        summary.appendChild(wrapper);
      } else {
        summary.appendChild(parts.suggestion.blockquote.cloneNode(true));
      }
    }

    // --- Expand hint ---
    const hint = document.createElement('span');
    hint.className = 'ai-expand-hint';
    hint.textContent = '▸';
    summary.appendChild(hint);

    details.appendChild(summary);

    // --- Collapsible body ---
    details.appendChild(document.createElement('hr'));
    appendClonedIfPresent(details, parts.filePathEl);
    details.appendChild(document.createElement('hr'));
    appendClonedIfPresent(
      details,
      parts.issue.header,
      parts.issue.blockquote,
      parts.context.header,
      parts.context.blockquote,
    );

    return details;
  }

  // ---------------------------------------------------------------------------
  // Formatting logic
  // ---------------------------------------------------------------------------

  /**
   * Format a single comment element by wrapping AI review content inside a
   * collapsible `<details>/<summary>` widget.
   *
   * @param {HTMLElement} element - The comment DOM element.
   * @returns {boolean} Whether the comment was formatted.
   */
  function formatSingleComment(element) {
    if (element.dataset[CONFIG.formattedKey] === 'true') return false;
    if (!isAIReviewComment(element)) return false;

    element.dataset[CONFIG.formattedKey] = 'true';

    const parts = extractCommentParts(element);

    // Inject severity badge into the comment header before clearing the body.
    injectSeverityIntoHeader(element, parts.severityH3);

    const details = buildFormattedDetails(parts);

    element.innerHTML = '';
    element.appendChild(details);
    return true;
  }

  /**
   * Find all comment elements on the page and format the AI-generated ones.
   */
  function formatComments() {
    log('formatting comments…');

    const selector = CONFIG.commentSelectors.join(', ');
    const allMatches = Array.from(document.querySelectorAll(selector));
    const comments = filterInnermostElements(allMatches);

    if (comments.length === 0) {
      log('no comments found on this page.');
      return;
    }

    let formattedCount = 0;
    for (const comment of comments) {
      if (formatSingleComment(comment)) formattedCount++;
    }

    log(`formatted ${formattedCount} of ${comments.length} comment(s).`);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  // Format existing comments immediately.
  formatComments();

  // Re-format when the DOM changes (SPA navigation, lazy-loaded comments).
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(formatComments, CONFIG.debounceMs);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();