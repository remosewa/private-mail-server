import { Readable } from 'stream';
import { simpleParser, ParsedMail } from 'mailparser';

/**
 * Represents a parsed email message from an mbox file
 */
export interface MboxMessage {
  headers: Record<string, string>;  // All email headers
  body: string;                     // Message body (text/html)
  flags: string[];                  // Status flags from mbox
  size: number;                     // Message size in bytes
  raw: string;                      // Raw RFC 822 message
}

/**
 * Parse mbox format stream and extract individual email messages.
 * 
 * Mbox format uses "From " lines as message separators. Each message
 * is in RFC 822 format.
 * 
 * This implementation uses streaming to handle large mbox files without
 * loading the entire file into memory.
 * 
 * @param stream Readable stream of mbox file content
 * @yields Individual parsed email messages
 * 
 * @example
 * ```typescript
 * const stream = fs.createReadStream('inbox.mbox');
 * for await (const message of parseMbox(stream)) {
 *   console.log(message.headers['subject']);
 * }
 * ```
 */
export async function* parseMbox(stream: Readable): AsyncGenerator<MboxMessage> {
  const currentLines: string[] = [];
  let inMessage = false;
  let lineBuffer = '';
  
  // Process stream line by line
  for await (const chunk of stream) {
    const text = chunk.toString('utf-8');
    lineBuffer += text;
    
    const lines = lineBuffer.split('\n');
    // Keep last incomplete line in buffer
    lineBuffer = lines.pop() || '';
    
    for (const line of lines) {
      // Mbox format: messages are separated by lines starting with "From "
      // Format: "From sender@example.com Mon Jan 01 00:00:00 2024"
      if (line.startsWith('From ')) {
        // If we have a current message, parse and yield it
        if (inMessage && currentLines.length > 0) {
          const rawMessage = currentLines.join('\n');
          const parsed = await parseMessage(rawMessage);
          if (parsed) {
            yield parsed;
          }
        }
        // Start new message
        // Note: We skip the "From " envelope line as it's not part of RFC 822.
        // The worker Lambda will strip it again if present, so this is safe.
        currentLines.length = 0;
        inMessage = true;
      } else if (inMessage) {
        // Accumulate message content (line by line to avoid string concatenation overhead)
        currentLines.push(line);
      }
    }
  }
  
  // Process any remaining content in buffer
  if (lineBuffer) {
    currentLines.push(lineBuffer);
  }
  
  // Parse and yield the last message
  if (inMessage && currentLines.length > 0) {
    const rawMessage = currentLines.join('\n');
    const parsed = await parseMessage(rawMessage);
    if (parsed) {
      yield parsed;
    }
  }
}

/**
 * Parse a single RFC 822 email message and extract metadata.
 * 
 * @param rawMessage Raw RFC 822 message content
 * @returns Parsed message with headers, body, and metadata
 */
async function parseMessage(rawMessage: string): Promise<MboxMessage | null> {
  try {
    // Extract mbox status flags from X-Status and Status headers
    const flags = extractMboxFlags(rawMessage);
    
    // Parse the RFC 822 message using mailparser
    const parsed: ParsedMail = await simpleParser(rawMessage);
    
    // Extract all headers as key-value pairs
    const headers: Record<string, string> = {};
    if (parsed.headers) {
      for (const [key, value] of parsed.headers) {
        // Convert header values to strings
        if (Array.isArray(value)) {
          headers[key] = value.join(', ');
        } else if (typeof value === 'object' && value !== null) {
          headers[key] = JSON.stringify(value);
        } else {
          headers[key] = String(value || '');
        }
      }
    }
    
    // Prefer HTML body, fall back to text
    const body = parsed.html || parsed.text || '';
    
    return {
      headers,
      body,
      flags,
      size: rawMessage.length,
      raw: rawMessage,
    };
  } catch (error) {
    console.error('Failed to parse message:', error);
    return null;
  }
}

/**
 * Extract mbox status flags from message headers.
 * 
 * Mbox format uses special headers to indicate message status:
 * - Status: R (read), O (old)
 * - X-Status: A (answered), F (flagged), T (draft), D (deleted)
 * - X-Mozilla-Status: Numeric flags (Thunderbird)
 * 
 * @param rawMessage Raw message content
 * @returns Array of flag strings
 */
export function extractMboxFlags(rawMessage: string): string[] {
  const flags: string[] = [];
  
  // Extract Status header (R = read, O = old)
  const statusMatch = rawMessage.match(/^Status:\s*([RO]+)/m);
  if (statusMatch) {
    const statusFlags = statusMatch[1];
    if (statusFlags.includes('R')) flags.push('read');
    if (statusFlags.includes('O')) flags.push('old');
  }
  
  // Extract X-Status header (A = answered, F = flagged, T = draft, D = deleted)
  const xStatusMatch = rawMessage.match(/^X-Status:\s*([AFTD]+)/m);
  if (xStatusMatch) {
    const xStatusFlags = xStatusMatch[1];
    if (xStatusFlags.includes('A')) flags.push('answered');
    if (xStatusFlags.includes('F')) flags.push('flagged');
    if (xStatusFlags.includes('T')) flags.push('draft');
    if (xStatusFlags.includes('D')) flags.push('deleted');
  }
  
  // Extract X-Mozilla-Status (Thunderbird numeric flags)
  const mozillaStatusMatch = rawMessage.match(/^X-Mozilla-Status:\s*(\d+)/m);
  if (mozillaStatusMatch) {
    const status = parseInt(mozillaStatusMatch[1], 16);
    // Thunderbird flag bits:
    // 0x0001 = read
    // 0x0002 = replied
    // 0x0004 = marked/flagged
    // 0x0008 = deleted
    if (status & 0x0001) flags.push('read');
    if (status & 0x0002) flags.push('answered');
    if (status & 0x0004) flags.push('flagged');
    if (status & 0x0008) flags.push('deleted');
  }
  
  return [...new Set(flags)]; // Remove duplicates
}
