# Private Mail Server

A self-hosted, end-to-end encrypted email server and web client that runs on AWS. All email content is encrypted client-side using your RSA key pair before being stored — the server never sees plaintext. Includes a full-featured web client with AI-powered semantic search, keyword search, labels, filters, and mbox import.

## Architecture

- **Frontend**: React + TypeScript SPA, served via CloudFront + S3
- **Backend**: AWS Lambda (Node.js 22), API Gateway HTTP API, DynamoDB, S3, SES, Cognito
- **Encryption**: RSA-OAEP + AES-GCM hybrid encryption; all keys managed client-side
- **Search**: FTS5 keyword search + sqlite-vec semantic embeddings, stored locally in OPFS (Origin Private File System)
- **Infrastructure**: AWS CDK (TypeScript)

## Security model

- Your RSA private key is derived from your password and never leaves your device
- All email content (headers, body, attachments) is encrypted before upload
- The server stores only ciphertext — it cannot read your email
- Push notifications include the encrypted header blob; decryption happens in the service worker using your locally-stored key
- Search indexes are built and stored locally in the browser's OPFS
- Semantic embeddings are computed locally using a WASM model

## Prerequisites

- AWS account with appropriate permissions
- AWS CLI configured (`aws configure`)
- Node.js 22+
- A domain name you control

## Setup

### 1. Install dependencies

```bash
npm install
cd web-client && npm install && cd ..
```

### 2. Bootstrap CDK (first time only)

```bash
npx cdk bootstrap
```

### 3. Deploy the backend

**Option A: New domain (CDK creates the hosted zone)**

```bash
npx cdk deploy --context domainName=yourdomain.com
```

After the first deploy, CDK outputs Route 53 nameservers. Update your domain registrar to point to them, then wait for DNS propagation (up to 48 hours) before SES can receive mail.

**Option B: Existing Route 53 hosted zone**

```bash
npx cdk deploy --context domainName=yourdomain.com --context hostedZoneId=Z1234567890ABC
```

This provisions:
- Route 53 hosted zone + DNS records (MX, SPF, DMARC, DKIM)
- SES domain identity for receiving and sending email
- S3 buckets (raw email storage, user data, web client hosting)
- DynamoDB tables (email metadata, user records)
- Cognito user pool (authentication)
- Lambda functions (email processing, API handler, sync, mbox import, etc.)
- API Gateway HTTP API
- CloudFront distribution

### 4. Configure the web client

Copy the example env file and fill in the values from your CDK deploy outputs:

```bash
cp web-client/.env.example web-client/.env
```

```env
VITE_API_URL=https://api.yourdomain.com
VITE_COGNITO_USER_POOL_ID=us-west-2_XXXXXXXXX
VITE_COGNITO_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_VAPID_PUBLIC_KEY=<from CDK outputs>
VITE_MAIL_DOMAIN=yourdomain.com
```

### 5. Deploy the frontend

```bash
DOMAIN_NAME=yourdomain.com npm run deploy:frontend
```

The deploy script reads the S3 bucket name and CloudFront distribution ID automatically from the CloudFormation stack outputs.

### 6. Register your first user

Navigate to `https://yourdomain.com` and create your account. Registration is invite-only — create an invite code first via the admin panel.

## Deploying updates

**Backend only:**
```bash
DOMAIN_NAME=yourdomain.com npm run deploy:backend
```

**Frontend only:**
```bash
npm run deploy:frontend
```

**Both:**
```bash
DOMAIN_NAME=yourdomain.com npm run deploy
```

## Email receiving

SES is configured to receive email at your domain and trigger the inbound processor Lambda. The MX record is automatically created pointing to `inbound-smtp.{region}.amazonaws.com`.

Domain verification (DKIM CNAME records) is created automatically by CDK and completes within a few minutes of DNS propagation.

## Mbox import

Import existing email from Gmail or other providers:

1. Export your email as an mbox file (Gmail: Google Takeout → Mail)
2. Navigate to Settings → Import in the web client
3. Upload the mbox file

Large imports are processed in batches via SQS + Lambda workers.

## Local development

**Frontend:**
```bash
cd web-client
npm run dev
```

The dev server runs at `http://localhost:5173`. You need a deployed backend — set `web-client/.env` with your deployed API URL and Cognito credentials.

**Lambda type-checking:**
```bash
npx tsc -p lambda/tsconfig.json
```

**Tests:**
```bash
npm test
```

## Project structure

```
├── bin/
│   └── chase-email.ts               CDK app entry point
├── lambda/
│   ├── api-handler/                 REST API (emails, sync, labels, folders, filters, etc.)
│   ├── inbound-email-processor/     Parses, encrypts, and stores incoming email
│   ├── sync-handler/                Delta sync endpoint
│   ├── mbox-indexer/                Mbox import orchestration
│   ├── mbox-worker/                 Mbox batch processing worker
│   ├── stream-processor/            DynamoDB stream → S3 cleanup on delete
│   ├── embedding-batch-processor/   Stores embedding S3 keys post-indexing
│   ├── header-migration/            One-time migration: headers S3 → DynamoDB inline
│   └── shared/                      Shared encryption utilities
├── lib/
│   └── chase-email-stack.ts         CDK stack definition (all infrastructure)
├── test/                            Jest unit tests
└── web-client/
    ├── public/
    │   └── sw.js                    Service worker (push notifications, client-side decrypt)
    └── src/
        ├── api/                     API client + remote logger
        ├── components/              React components (inbox, compose, filters, etc.)
        ├── crypto/                  Client-side encryption (RSA-OAEP + AES-GCM)
        ├── db/                      SQLite (OPFS) database layer + key store
        ├── pages/                   Page components (mail, settings, admin, login)
        ├── search/                  FTS5 + semantic search + background indexer
        ├── store/                   Zustand state stores
        └── sync/                    Delta sync manager + filter evaluator
```

## License

[AGPL-3.0](LICENSE)
