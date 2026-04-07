/**
 * Unit tests for htmlToPlainText function in inbound-email-processor
 * 
 * Tests that HTML email content is correctly converted to plain text
 * for keyword indexing.
 */

import * as fs from 'fs';
import * as path from 'path';

// Extract the function for testing — it's not exported, so we duplicate it here
// to match the exact implementation in handler.ts
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

describe('htmlToPlainText', () => {
  it('extracts text from simple HTML', () => {
    const html = '<p>Hello <b>world</b></p>';
    const result = htmlToPlainText(html);
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('strips style tags and their content', () => {
    const html = '<style>body { color: red; }</style><p>Hello</p>';
    const result = htmlToPlainText(html);
    expect(result).not.toContain('color');
    expect(result).toContain('Hello');
  });

  it('strips script tags and their content', () => {
    const html = '<script>alert("xss")</script><p>Hello</p>';
    const result = htmlToPlainText(html);
    expect(result).not.toContain('alert');
    expect(result).toContain('Hello');
  });

  it('decodes HTML entities', () => {
    const html = '<p>AT&amp;T &lt;test&gt; &quot;quoted&quot; it&#39;s</p>';
    const result = htmlToPlainText(html);
    expect(result).toContain('AT&T');
    expect(result).toContain('<test>');
    expect(result).toContain('"quoted"');
    expect(result).toContain("it's");
  });

  it('handles table-based email with text in td elements', () => {
    const html = `
      <table>
        <tr><td>Verona</td><td>Milano</td></tr>
        <tr><td>Trenitalia</td><td>Ticket</td></tr>
      </table>
    `;
    const result = htmlToPlainText(html);
    expect(result).toContain('Verona');
    expect(result).toContain('Milano');
    expect(result).toContain('Trenitalia');
    expect(result).toContain('Ticket');
  });

  it('extracts text from the example Trenitalia email', () => {
    const htmlPath = path.join(__dirname, '..', 'exampleemail.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    const result = htmlToPlainText(html);

    // The email should contain these keywords
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Trenitalia');
  });

  it('does not return empty string for HTML-only emails with content', () => {
    const html = '<html><body><table><tr><td>Some content here</td></tr></table></body></html>';
    const result = htmlToPlainText(html);
    expect(result).toBe('Some content here');
  });
});

describe('simpleParser text extraction', () => {
  it('extracts text from a forwarded email with HTML body', async () => {
    const { simpleParser } = await import('mailparser');
    const htmlPath = path.join(__dirname, '..', 'exampleemail.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

    // Simulate a forwarded email with the HTML as the body
    const rawEmail = [
      'From: test@example.com',
      'To: recipient@example.com',
      'Subject: Test',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      htmlContent,
    ].join('\r\n');

    const parsed = await simpleParser(rawEmail);
    const htmlBody = typeof parsed.html === 'string' ? parsed.html : '';
    const htmlText = htmlBody ? htmlToPlainText(htmlBody) : '';
    const textBody = htmlText || parsed.text || '';

    expect(textBody.length).toBeGreaterThan(0);
    expect(textBody).toContain('Trenitalia');
  });
});
