/**
 * api-handler Lambda — single-function HTTP API dispatcher.
 *
 * Trigger: API Gateway HTTP API (v2 payload format).
 *
 * Routes are matched on event.routeKey which API Gateway sets to
 * "<METHOD> <path>" e.g. "GET /emails/{ulid}/body".
 *
 * Public routes (no JWT):
 *   POST /auth/register
 *
 * Protected routes (Cognito JWT required, userId = sub claim):
 *   GET    /auth/key-bundle
 *   GET    /emails
 *   GET    /emails/{ulid}/header
 *   GET    /emails/{ulid}/body
 *   GET    /emails/{ulid}/text
 *   GET    /emails/{ulid}/embedding
 *   PUT    /emails/{ulid}/embedding
 *   GET    /emails/{ulid}/attachments
 *   GET    /emails/{ulid}/attachment/{index}
 *   PUT    /emails/{ulid}/flags
 *   POST   /emails/bulk-update
 *   DELETE /emails/{ulid}
 *   POST   /emails/send
 *   GET    /counts
 *   POST   /push/subscribe
 *   DELETE /push/subscribe
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handleRegister, handleKeyBundle, handleStoreRecoveryCodes } from './routes/auth';
import {
  handleListEmails,
  handleBatchGetEmails,
  handleGetEmailHeader,
  handleGetEmailBody,
  handleGetEmailText,
  handleBatchGetEmailText,
  handleGetEmailEmbedding,
  handlePutEmailEmbedding,
  handleGetEmailAttachments,
  handleGetEmailAttachmentBlob,
  handlePutEmailFlags,
  handleDeleteEmail,
  handleRestoreEmail,
  handleSendEmail,
  handleGetCounts,
  handleBulkUpdateEmails,
} from './routes/emails';
import { handlePushSubscribe, handlePushUnsubscribe } from './routes/push';
import { handlePutDraft, handleDeleteDraft } from './routes/drafts';
import { handleGetAttachmentUploadUrl, handleDeleteAttachment } from './routes/attachments';
import { handleGetFolderList, handlePutFolder, handleDeleteFolder, handlePutFolderOrdering } from './routes/folders';
import { handleGetLabelList, handlePutLabel, handleDeleteLabel } from './routes/labels';
import { handleGetUploadUrl, handleGetStatus, handleCancelMigration, handleCompleteMigration } from './routes/migration';
import { handleGetSync } from './routes/sync';
import { listFilters, getFilter, putFilter, deleteFilter } from './routes/filters';
import { handleGetSettings, handlePutSettings } from './routes/settings';
import { handleAdminListUsers, handleAdminCreateInvite, handleAdminListInvites, handleAdminInvalidateInvite } from './routes/admin';
import { handleClientLogs } from './routes/logs';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    switch (event.routeKey) {
      case 'POST /auth/register':                          return await handleRegister(event);
      case 'GET /auth/key-bundle':                         return await handleKeyBundle(event);
      case 'POST /auth/recovery-codes':                    return await handleStoreRecoveryCodes(event);
      case 'GET /emails':                                  return await handleListEmails(event);
      case 'POST /emails/batch-get':                       return await handleBatchGetEmails(event);
      case 'GET /emails/{ulid}/header':                    return await handleGetEmailHeader(event);
      case 'GET /emails/{ulid}/body':                      return await handleGetEmailBody(event);
      case 'GET /emails/{ulid}/text':                      return await handleGetEmailText(event);
      case 'POST /emails/text/batch':                      return await handleBatchGetEmailText(event);
      case 'GET /emails/{ulid}/embedding':                 return await handleGetEmailEmbedding(event);
      case 'PUT /emails/{ulid}/embedding':                 return await handlePutEmailEmbedding(event);
      case 'GET /emails/{ulid}/attachments':               return await handleGetEmailAttachments(event);
      case 'GET /emails/{ulid}/attachment/{attachmentId}':  return await handleGetEmailAttachmentBlob(event);
      case 'PUT /emails/{ulid}/flags':                     return await handlePutEmailFlags(event);
      case 'POST /emails/bulk-update':                     return await handleBulkUpdateEmails(event);
      case 'DELETE /emails/{ulid}':                        return await handleDeleteEmail(event);
      case 'POST /emails/{ulid}/restore':                  return await handleRestoreEmail(event);
      case 'POST /emails/send':                            return await handleSendEmail(event);
      case 'GET /counts':                                  return await handleGetCounts(event);
      case 'POST /push/subscribe':                                   return await handlePushSubscribe(event);
      case 'DELETE /push/subscribe':                               return await handlePushUnsubscribe(event);
      case 'PUT /drafts/{ulid}':                                   return await handlePutDraft(event);
      case 'DELETE /drafts/{ulid}':                                return await handleDeleteDraft(event);
      case 'POST /attachments/upload-url':                         return await handleGetAttachmentUploadUrl(event);
      case 'DELETE /attachments/{emailId}/{attachmentId}':         return await handleDeleteAttachment(event);
      case 'GET /folders/list':                                    return await handleGetFolderList(event);
      case 'PUT /folders/{folderId}':                              return await handlePutFolder(event);
      case 'DELETE /folders/{folderId}':                           return await handleDeleteFolder(event);
      case 'PUT /folders/ordering':                                return await handlePutFolderOrdering(event);
      case 'GET /labels/list':                                     return await handleGetLabelList(event);
      case 'PUT /labels/{labelId}':                                return await handlePutLabel(event);
      case 'DELETE /labels/{labelId}':                             return await handleDeleteLabel(event);
      case 'GET /migration/upload-url':                            return await handleGetUploadUrl(event);
      case 'GET /migration/status':                                return await handleGetStatus(event);
      case 'POST /migration/cancel':                               return await handleCancelMigration(event);
      case 'POST /migration/complete':                             return await handleCompleteMigration(event);
      case 'GET /sync':                                            return await handleGetSync(event);
      case 'GET /filters':                                         return await listFilters(event);
      case 'GET /filters/{filterId}':                              return await getFilter(event);
      case 'PUT /filters/{filterId}':                              return await putFilter(event);
      case 'DELETE /filters/{filterId}':                           return await deleteFilter(event);
      case 'GET /settings':                                        return await handleGetSettings(event);
      case 'PUT /settings':                                        return await handlePutSettings(event);
      case 'GET /admin/users':                                     return await handleAdminListUsers(event);
      case 'POST /admin/invites':                                  return await handleAdminCreateInvite(event);
      case 'GET /admin/invites':                                   return await handleAdminListInvites(event);
      case 'DELETE /admin/invites/{inviteCode}':                   return await handleAdminInvalidateInvite(event);
      case 'POST /client-logs':                                    return await handleClientLogs(event);
      default:
        return { statusCode: 404, body: 'Not Found' };
    }
  } catch (err) {
    console.error('[api-handler] Unhandled error:', err);
    // AWS SDK client errors (4xx from AWS services) surface as user-visible errors
    if ((err as { $fault?: string }).$fault === 'client') {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: (err as Error).message }),
      };
    }
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
