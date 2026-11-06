// Renders the agent's replies. Everything goes through React elements, never as HTML, so a reply
// (which may quote text from an imported post) cannot inject markup. Parsing lives in markdown.ts.
import type { ReactNode } from 'react';
import { parseBlocks, parseInline } from './markdown.ts';

function renderInline(text: string): ReactNode[] {
  return parseInline(text).map((part, i) => {
    switch (part.kind) {
      case 'bold':
        return <strong key={i}>{part.text}</strong>;
      case 'code':
        return <code key={i}>{part.text}</code>;
      case 'link':
        return (
          <a key={i} href={part.href} target="_blank" rel="noreferrer noopener">
            {part.text}
          </a>
        );
      default:
        return part.text;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <p key={i} className="md-h">
                {renderInline(b.text)}
              </p>
            );
          case 'ul':
          case 'ol': {
            const Tag = b.kind;
            return (
              <Tag key={i}>
                {b.items.map((item, n) => (
                  <li key={n}>{renderInline(item)}</li>
                ))}
              </Tag>
            );
          }
          case 'code':
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          default:
            return <p key={i}>{renderInline(b.text)}</p>;
        }
      })}
    </div>
  );
}
