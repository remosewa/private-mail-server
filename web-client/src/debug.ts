/**
 * Debug utilities for browser console
 * 
 * Usage in console:
 *   const debug = await import('./debug.ts');
 *   await debug.decryptHeaderBlob('01ABC123...');
 */

import { getDb } from './db/Database';
import { decryptBlob, unwrapEmailKey, decryptAttachment, decodeJson } from './crypto/BlobCrypto';
import { useAuthStore } from './store/authStore';
import type { EmailHeaderBlob } from './types';

/**
 * Decrypt and print the header blob for a given email ULID
 */
export async function decryptHeaderBlob(ulid: string): Promise<void> {
  try {
    // Get private key from auth store
    const privateKey = useAuthStore.getState().privateKey;
    if (!privateKey) {
      console.error('❌ No private key available. Are you logged in?');
      return;
    }

    console.log(`🔍 Fetching email metadata from server for ULID: ${ulid}`);

    // Dynamically import the email API
    const { batchGetEmails } = await import('./api/emails');

    // Fetch email from server
    const response = await batchGetEmails([ulid]);

    if (response.items.length === 0) {
      console.error(`❌ Email not found on server: ${ulid}`);
      return;
    }

    const email = response.items[0];
    const headerBlob = email.headerBlob;
    const wrappedEmailKey = email.wrappedEmailKey;

    if (!headerBlob) {
      console.error(`❌ No header blob for email: ${ulid}`);
      return;
    }

    console.log(`📧 Found email on server`);
    console.log(`🔑 Has wrappedEmailKey: ${!!wrappedEmailKey}`);
    console.log(`📦 Header blob size: ${headerBlob.length} bytes (base64)`);

    // Decrypt the header blob
    const bytes = Uint8Array.from(atob(headerBlob), c => c.charCodeAt(0));
    let header: EmailHeaderBlob;

    if (wrappedEmailKey) {
      // Draft/sent: unwrap the per-email AES key, then decrypt the blob
      console.log('🔓 Decrypting with wrapped email key (draft/sent)...');
      const emailKey = await unwrapEmailKey(wrappedEmailKey, privateKey);
      const plaintext = new Uint8Array(await decryptAttachment(bytes.buffer, emailKey));
      header = decodeJson<EmailHeaderBlob>(plaintext);
    } else {
      // Inbound: RSA-hybrid format
      console.log('🔓 Decrypting with RSA-hybrid (inbound)...');
      header = decodeJson<EmailHeaderBlob>(await decryptBlob(bytes.buffer, privateKey));
    }

    console.log('✅ Decrypted header blob:');
    console.log(JSON.stringify(header, null, 2));

    // Highlight important fields
    console.log('\n📋 Key fields:');
    console.log(`  Subject: ${header.subject}`);
    console.log(`  From: ${header.fromName} <${header.fromAddress}>`);
    console.log(`  To: ${header.to.join(', ')}`);
    console.log(`  Date: ${header.date}`);
    console.log(`  List-Unsubscribe: ${header.listUnsubscribe ?? '(not present)'}`);
    console.log(`  List-Unsubscribe-Post: ${header.listUnsubscribePost ?? '(not present)'}`);

    // Return the header object for further inspection
    (window as any).__lastDecryptedHeader = header;
    console.log('\n💡 Header saved to window.__lastDecryptedHeader for inspection');

  } catch (error) {
    console.error('❌ Failed to decrypt header:', error);
  }
}

/**
 * List all emails with List-Unsubscribe headers
 */
export async function findEmailsWithUnsubscribe(): Promise<void> {
  try {
    const db = await getDb();
    const rows = await db.selectObjects(
      'SELECT ulid, subject, fromAddress, listUnsubscribe FROM email_metadata WHERE listUnsubscribe IS NOT NULL LIMIT 20'
    );

    if (rows.length === 0) {
      console.log('📭 No emails with List-Unsubscribe headers found in database');
      return;
    }

    console.log(`📬 Found ${rows.length} emails with List-Unsubscribe headers:`);
    console.table(rows.map(r => ({
      ulid: r['ulid'],
      subject: r['subject'],
      from: r['fromAddress'],
      hasUnsubscribe: !!r['listUnsubscribe'],
    })));

    console.log('\n💡 Use decryptHeaderBlob(ulid) to inspect a specific email');
  } catch (error) {
    console.error('❌ Failed to query database:', error);
  }
}

/**
 * Get the currently selected email ULID
 */
export function getCurrentEmailUlid(): string | null {
  const { selectedEmailUlid } = (window as any).__uiStore?.getState() || {};
  if (selectedEmailUlid) {
    console.log(`📧 Current email ULID: ${selectedEmailUlid}`);
    return selectedEmailUlid;
  }
  console.log('❌ No email currently selected');
  return null;
}

/**
 * Decrypt the currently selected email's header
 */
export async function decryptCurrentHeader(): Promise<void> {
  const ulid = getCurrentEmailUlid();
  if (ulid) {
    await decryptHeaderBlob(ulid);
  }
}

// Make functions available globally for easy console access
if (typeof window !== 'undefined') {
  (window as any).debugEmail = {
    decryptHeaderBlob,
    findEmailsWithUnsubscribe,
    getCurrentEmailUlid,
    decryptCurrentHeader,
  };
  console.log('🐛 Debug utilities loaded. Available commands:');
  console.log('  debugEmail.decryptCurrentHeader() - Decrypt currently selected email');
  console.log('  debugEmail.decryptHeaderBlob(ulid) - Decrypt specific email');
  console.log('  debugEmail.findEmailsWithUnsubscribe() - List emails with unsubscribe headers');
  console.log('  debugEmail.getCurrentEmailUlid() - Get current email ULID');
}

/**
 * Get embeddings for a given email ULID from the local database
 */
export async function getEmailEmbeddings(ulid: string): Promise<void> {
  try {
    const db = await getDb();

    // Check email_embeddings table
    const embRows = await db.selectObjects(
      'SELECT ulid, model, n_chunks, length(emb_data) as emb_bytes FROM email_embeddings WHERE ulid = ?',
      [ulid]
    );

    if (embRows.length === 0) {
      console.log(`❌ No embeddings found for ${ulid}`);
      return;
    }

    const emb = embRows[0];
    console.log('✅ Embedding record:', {
      ulid: emb['ulid'],
      model: emb['model'],
      nChunks: emb['n_chunks'],
      embBytes: emb['emb_bytes'],
    });

    // Check email_vecs table
    const vecRows = await db.selectObjects(
      'SELECT ulid, chunk_idx, length(embedding) as vec_bytes FROM email_vecs WHERE ulid = ? ORDER BY chunk_idx',
      [ulid]
    );
    console.log(`📐 Vector chunks (${vecRows.length}):`, vecRows.map(r => ({
      chunk: r['chunk_idx'],
      bytes: r['vec_bytes'],
    })));

    // Check FTS
    const ftsRows = await db.selectObjects(
      `SELECT m.ulid, length(f.body_text) as body_len, f.body_text
       FROM email_metadata m
       JOIN email_fts f ON f.rowid = m.email_id
       WHERE m.ulid = ?`,
      [ulid]
    );
    if (ftsRows.length > 0) {
      const bodyText = ftsRows[0]['body_text'] as string ?? '';
      console.log(`📝 FTS body_text: ${ftsRows[0]['body_len']} chars`);
      console.log(`   Preview: "${bodyText.slice(0, 200)}..."`);
    } else {
      console.log('❌ No FTS row found');
    }

    // Check indexed_at
    const metaRows = await db.selectObjects(
      'SELECT ulid, indexed_at, s3EmbeddingKey FROM email_metadata WHERE ulid = ?',
      [ulid]
    );
    if (metaRows.length > 0) {
      console.log('📋 Metadata:', {
        indexed_at: metaRows[0]['indexed_at'],
        s3EmbeddingKey: metaRows[0]['s3EmbeddingKey'],
      });
    }
  } catch (error) {
    console.error('❌ Failed to get embeddings:', error);
  }
}

// Register on window
if (typeof window !== 'undefined') {
  (window as any).debugEmail.getEmailEmbeddings = getEmailEmbeddings;
  console.log('  debugEmail.getEmailEmbeddings(ulid) - Show embeddings for an email');
}

/**
 * Fetch and display the keyword-indexed content for a given email ULID.
 * Uses the same code path as the indexer.
 */
export async function getEmailIndexContent(ulid: string): Promise<void> {
  try {
    const privateKey = useAuthStore.getState().privateKey;
    if (!privateKey) {
      console.error('❌ No private key available. Are you logged in?');
      return;
    }

    const db = await getDb();

    // Get wrappedEmailKey from local DB
    const rows = await db.selectObjects(
      'SELECT ulid, wrappedEmailKey, s3TextKey FROM email_metadata WHERE ulid = ?',
      [ulid]
    );

    if (rows.length === 0) {
      console.error(`❌ Email not found locally: ${ulid}`);
      return;
    }

    const row = rows[0];
    if (!row['s3TextKey']) {
      console.error(`❌ No s3TextKey for email: ${ulid}`);
      return;
    }

    console.log(`🔍 Fetching text for ${ulid}...`);

    const { fetchEmailText } = await import('./search/emailText');
    const text = await fetchEmailText(ulid, privateKey, row['wrappedEmailKey'] as string | null);

    console.log(`✅ Email text (${text.length} chars):`);
    console.log(text);
    //if (text.length > 2000) console.log(`... (${text.length - 2000} more chars)`);

    // Show what chunks would be created for embedding
    const { chunkText } = await import('./search/chunker');
    const chunks = chunkText(text);
    console.log(`\n📦 Would produce ${chunks.length} embedding chunks`);
    chunks.forEach((c, i) => console.log(`  Chunk ${i + 1}: "${c.slice(0, 80)}..."`));

    (window as any).__lastEmailText = text;
    console.log('\n💡 Full text saved to window.__lastEmailText');
  } catch (error) {
    console.error('❌ Failed to get email index content:', error);
  }
}

if (typeof window !== 'undefined') {
  (window as any).debugEmail.getEmailIndexContent = getEmailIndexContent;
  console.log('  debugEmail.getEmailIndexContent(ulid) - Show keyword-indexed content for an email');
}
