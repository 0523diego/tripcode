// Renders the agent's replies. Everything goes through React elements, never as HTML, so a reply
// (which may quote text from an imported post) cannot inject markup. Parsing lives in markdown.ts.
import type { ReactNode } from 'react';
import { fileUrl } from './files.ts';
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
      case 'image':
        // A picture from trips/ is shown; a picture from the web is not loaded on its own (an address the agent
        // was talked into writing could carry something out), it is a link the user chooses to open.
        return part.local ? (
          <a key={i} href={fileUrl(part.src)} target="_blank" rel="noreferrer noopener" className="md-img-link">
            <img src={fileUrl(part.src)} alt={part.alt} loading="lazy" className="md-img" />
          </a>
        ) : (
          <a key={i} href={part.src} target="_blank" rel="noreferrer noopener" className="md-img-remote">
            外部圖片：{part.alt || part.src}
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
          case 'table':
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((cell, n) => (
                        <th key={n} style={b.align[n] ? { textAlign: b.align[n] } : undefined}>
                          {renderInline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, n) => (
                          <td key={n} style={b.align[n] ? { textAlign: b.align[n] } : undefined}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <p key={i}>{renderInline(b.text)}</p>;
        }
      })}
    </div>
  );
}
