import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { DnsValidatedCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cr from 'aws-cdk-lib/custom-resources';

export class PrivateMailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = this.node.tryGetContext('domainName') as string | undefined;
    if (!domainName) {
      throw new Error(
        'Context variable "domainName" is required.\n' +
        'Deploy with: cdk deploy --context domainName=yourdomain.com',
      );
    }

    // =========================================================
    // Route 53 — Hosted Zone
    // =========================================================
    // On a fresh deploy pass only --context domainName=... and CDK creates the zone.
    // On recovery (zone already exists), also pass --context hostedZoneId=<id> so CDK
    // imports the existing zone instead of creating a duplicate (which would require
    // updating NS records at the registrar again).
    const hostedZoneId = this.node.tryGetContext('hostedZoneId') as string | undefined;

    // ownedZone is only set when CDK creates the zone (not when imported).
    // We need it to emit the NameServers output (not available on imported zones).
    let ownedZone: route53.PublicHostedZone | undefined;
    const hostedZone: route53.IPublicHostedZone = hostedZoneId
      ? route53.PublicHostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId,
        zoneName: domainName,
      })
      : (ownedZone = new route53.PublicHostedZone(this, 'HostedZone', {
        zoneName: domainName,
        comment: 'Chase Email — managed by CDK',
      }));

    // MX record — route inbound mail to SES (zone apex, no recordName)
    new route53.MxRecord(this, 'SESInboundMX', {
      zone: hostedZone,
      values: [{ priority: 10, hostName: `inbound-smtp.${this.region}.amazonaws.com` }],
      ttl: cdk.Duration.minutes(5),
    });

    // =========================================================
    // SES — Domain Identity
    // Using publicHostedZone automatically creates the three DKIM CNAME
    // records and the MAIL FROM MX + SPF records in Route 53.
    // =========================================================
    new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(hostedZone),
      mailFromDomain: `mail.${domainName}`,
      dkimSigning: true,
    });

    // SPF at zone apex — hard-fail any non-SES sender
    new route53.TxtRecord(this, 'SPFRecord', {
      zone: hostedZone,
      values: ['v=spf1 include:amazonses.com -all'],
      ttl: cdk.Duration.minutes(5),
    });

    // DMARC — quarantine policy, strict alignment, aggregate reports
    new route53.TxtRecord(this, 'DMARCRecord', {
      zone: hostedZone,
      recordName: '_dmarc',
      values: [
        `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${domainName}; adkim=s; aspf=s;`,
      ],
      ttl: cdk.Duration.minutes(5),
    });

    // =========================================================
    // S3 — raw-email-bucket
    // SES drops raw .eml files under incoming/.
    // Failed emails are moved to dead-letter/ for inspection.
    // Migration emails are processed under migration/ prefix.
    // =========================================================
    const rawEmailBucket = new s3.Bucket(this, 'RawEmailBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'ExpireIncomingEmails',
          prefix: 'incoming/',
          enabled: true,
          expiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
        {
          id: 'ExpireDeadLetterEmails',
          prefix: 'dead-letter/',
          enabled: true,
          expiration: cdk.Duration.days(30), // longer retention for investigation
        },
        {
          id: 'ExpireMigrationEmails',
          prefix: 'migration/',
          enabled: true,
          expiration: cdk.Duration.days(1), // processed quickly, clean up fast
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // =========================================================
    // S3 — migration-upload-bucket
    // Users upload zip files containing mbox archives.
    // Files are automatically deleted after 1 day (safety cleanup).
    // =========================================================
    const migrationUploadBucket = new s3.Bucket(this, 'MigrationUploadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'ExpireUploadedZips',
          prefix: 'uploads/',
          enabled: true,
          expiration: cdk.Duration.days(1),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      cors: [
        {
          allowedOrigins: ['*'],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // =========================================================
    // S3 — migration-mbox-bucket
    // Extracted mbox files from zip archives.
    // Files are automatically deleted after 7 days (safety cleanup).
    // =========================================================
    const migrationMboxBucket = new s3.Bucket(this, 'MigrationMboxBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'ExpireMboxFiles',
          prefix: 'mbox/',
          enabled: true,
          expiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Allow SES service to PutObject — scoped to this account (confused-deputy protection)
    rawEmailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSESInboundPut',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [rawEmailBucket.arnForObjects('*')],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
    );

    // =========================================================
    // S3 — user-data-bucket
    // Permanent store for encrypted email bodies and embedding blobs.
    // All objects are encrypted client-side; S3-managed SSE is defence-in-depth.
    // =========================================================
    const userDataBucket = new s3.Bucket(this, 'UserDataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [{
        allowedOrigins: ['*'],
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
        allowedHeaders: ['*'],
        maxAge: 3000,
      }],
    });

    // =========================================================
    // DynamoDB — emails table
    // PK: USER#<userId>  |  SK: EMAIL#<ulid>
    // ULID-based SK gives natural time-ordering within a user partition.
    //
    // Non-key attributes:
    //   userId           — plain userId (GSI PK for UserFolderIndex and UserUpdatesIndex)
    //   folderId         — system folder ID e.g. "INBOX" / "SENT" / "TRASH" (GSI sort key)
    //                      names are resolved client-side via config table
    //   labelIds         — list of label IDs applied to the email (names in config table)
    //   messageId        — raw Message-ID header (LSI sort key for thread lookup)
    //   threadId         — "THREAD#<ulid>" — assigned at ingest, propagated from parent
    //   s3HeaderKey      — S3 key: encrypted { subject, fromName, fromAddress, preview, to, date }
    //   s3BodyKey        — S3 key: encrypted { textBody, htmlBody } — fetched only when reading
    //   s3TextKey        — S3 key: encrypted { text } — plaintext for FTS5 index rebuild
    //   s3EmbeddingKey   — S3 key: encrypted chunk vectors (stub at ingest; client-replaced)
    //   s3AttachmentsKey — S3 key: encrypted [{ filename, size, contentType, contentId? }]
    //   hasAttachments   — 1 if email has attachments, 0 otherwise
    //   subjectHash      — HMAC-SHA256(userId, subject) — no plaintext stored
    //   fromHash         — HMAC-SHA256(userId, from)    — no plaintext stored
    //   read             — Boolean
    //   receivedAt       — ISO-8601 timestamp
    //   lastUpdatedAt    — ISO-8601 UTC timestamp (GSI sort key for UserUpdatesIndex)
    //   ttl              — Unix epoch s (set only when moved to TRASH; enables auto-expiry)
    //
    // Note: In-Reply-To header is NOT stored in plaintext. It's used during ingestion
    // to resolve the threadId via LSI_MessageId lookup, then discarded. The encrypted
    // header blob in s3HeaderKey contains the full In-Reply-To value if needed.
    // =========================================================
    const emailsTable = new dynamodb.Table(this, 'EmailsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.OLD_IMAGE, // needed by stream-processor to get S3 keys on delete
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // LSI: LSI_MessageId — look up a message by its Message-ID within one user partition.
    // Used at ingest time to find a parent message's threadId when In-Reply-To is present.
    // INCLUDE projection with only threadId keeps LSI storage minimal.
    emailsTable.addLocalSecondaryIndex({
      indexName: 'LSI_MessageId',
      sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['threadId'],
    });

    // GSI: UserFolderIndex — query emails by folder for a user
    emailsTable.addGlobalSecondaryIndex({
      indexName: 'UserFolderIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'folderId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: UserUpdatesIndex — query emails by lastUpdatedAt for timestamp-based sync
    emailsTable.addGlobalSecondaryIndex({
      indexName: 'UserUpdatesIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lastUpdatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // =========================================================
    // DynamoDB — users table
    // PK: userId
    //
    // Attributes:
    //   email              — verified email address
    //   publicKey          — PEM-encoded RSA public key (SPKI, from device keygen)
    //   encryptedPrivateKey— private key wrapped with Argon2id-derived KEK; never plaintext
    //   argon2Salt         — random salt for the Argon2id KDF (base64)
    // =========================================================
    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'chase-users',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI: UserEmailIndex — look up userId by email address (used by ingest Lambda)
    usersTable.addGlobalSecondaryIndex({
      indexName: 'UserEmailIndex',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // =========================================================
    // DynamoDB — invites table
    // PK: inviteCode (UUID, manually created by admin)
    //
    // Attributes:
    //   createdBy  — who generated the invite
    //   expiresAt  — Unix epoch TTL (DynamoDB auto-expires the item too)
    //   usedAt     — Unix epoch timestamp set on first use; absent = unused
    //   maxUses    — reserved for future multi-use invite support
    // =========================================================
    const invitesTable = new dynamodb.Table(this, 'InvitesTable', {
      tableName: 'chase-invites',
      partitionKey: { name: 'inviteCode', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // =========================================================
    // Cognito — User Pool
    // selfSignUpEnabled=false enforces invite-only registration.
    // The API Lambda creates users via admin APIs.
    // Clients authenticate directly against Cognito (USER_PASSWORD_AUTH or
    // USER_SRP_AUTH) to obtain JWTs used by API Gateway.
    // =========================================================
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'chase-email-users',
      selfSignUpEnabled: false, // registration only via POST /auth/register
      signInAliases: { username: true, email: false },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true, // TOTP via Google Authenticator, Authy, 1Password, etc.
      },
      passwordPolicy: {
        minLength: 16,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.NONE, // no email recovery; user holds encrypted key
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: 'chase-android-client',
      generateSecret: false, // native app can't keep a secret
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
    });

    // =========================================================
    // IAM Roles — one per Lambda family, least-privilege
    // =========================================================

    // --- SES Ingest Lambda ---
    // Reads raw .eml, encrypts body, writes to userDataBucket,
    // indexes metadata in emailsTable, publishes SNS notification.
    const sesIngestRole = new iam.Role(this, 'SESIngestLambdaRole', {
      roleName: 'chase-ses-ingest-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'SES ingest Lambda: read raw S3, write encrypted blobs, write DDB metadata',
    });
    rawEmailBucket.grantRead(sesIngestRole);
    rawEmailBucket.grantDelete(sesIngestRole);    // delete raw .eml after processing
    rawEmailBucket.grantPut(sesIngestRole);       // write to dead-letter/ prefix
    userDataBucket.grantPut(sesIngestRole);
    // Read access required for: resolveThreadId (LSI_MessageId query) + idempotency check
    emailsTable.grantReadWriteData(sesIngestRole);
    usersTable.grantReadData(sesIngestRole);
    // Allow publishing to any per-user notification topic (created at registration time)
    sesIngestRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowSNSPublishToUserTopics',
        effect: iam.Effect.ALLOW,
        actions: ['sns:Publish'],
        resources: [`arn:aws:sns:${this.region}:${this.account}:chase-email-new-*`],
      }),
    );
    // Allow reading VAPID private key from SSM (for Web Push) + decrypt with AWS-managed key
    sesIngestRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowSSMVapidKeyRead',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/chase-email/vapid-private-key`],
      }),
    );

    // --- API Lambda ---
    // Serves encrypted blobs and metadata to authenticated Android clients.
    const apiLambdaRole = new iam.Role(this, 'APILambdaRole', {
      roleName: 'chase-api-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'API Lambda: serve encrypted email data to authenticated clients',
    });
    userDataBucket.grantReadWrite(apiLambdaRole);
    migrationUploadBucket.grantReadWrite(apiLambdaRole);
    migrationMboxBucket.grantReadWrite(apiLambdaRole); // For deleting mbox files on migration completion/cancellation
    emailsTable.grantReadWriteData(apiLambdaRole);
    usersTable.grantReadWriteData(apiLambdaRole);  // write for registration
    invitesTable.grantReadWriteData(apiLambdaRole);
    // Admin endpoints: scan both tables to list users and invites
    apiLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowAdminScan',
      actions: ['dynamodb:Scan'],
      resources: [usersTable.tableArn, invitesTable.tableArn],
    }));
    // Cognito admin operations for invite-gated registration
    apiLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowCognitoAdminOps',
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminGetUser',
      ],
      resources: [userPool.userPoolArn],
    }));
    // SES outbound send (resource-level permissions not supported for SendRawEmail)
    apiLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowSESSendRaw',
      actions: ['ses:SendRawEmail'],
      resources: ['*'],
    }));
    // Create per-user SNS topics at registration time
    apiLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowSNSCreateUserTopics',
      actions: ['sns:CreateTopic'],
      resources: [`arn:aws:sns:${this.region}:${this.account}:chase-email-new-*`],
    }));

    // --- Auth Lambda ---
    // Registration and login: manages user records, returns encrypted private key blob.
    const authLambdaRole = new iam.Role(this, 'AuthLambdaRole', {
      roleName: 'chase-auth-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'Auth Lambda: register users, handle login, manage per-user SNS topics',
    });
    usersTable.grantReadWriteData(authLambdaRole);
    // Auth Lambda creates per-user SNS topics at registration time
    authLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowSNSTopicManagement',
        effect: iam.Effect.ALLOW,
        actions: ['sns:CreateTopic', 'sns:DeleteTopic', 'sns:Subscribe', 'sns:Unsubscribe'],
        resources: [`arn:aws:sns:${this.region}:${this.account}:chase-email-new-*`],
      }),
    );

    // =========================================================
    // SQS — Dead-letter queue for failed inbound email processing
    // Events land here after Lambda exhausts all retries (default: 2 retries = 3 attempts).
    // Redrive: copy the raw .eml back to incoming/ then send the original S3 event to the queue.
    // =========================================================
    const ingestDlq = new sqs.Queue(this, 'IngestDLQ', {
      queueName: 'chase-inbound-processor-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // =========================================================
    // SQS — IMAP Migration Queues
    // Dead letter queue for failed migration batches after 3 retry attempts.
    // Main queue orchestrates batch processing with 5-minute visibility timeout.
    // =========================================================
    const migrationDlq = new sqs.Queue(this, 'MigrationDLQ', {
      queueName: 'chase-imap-migration-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const migrationQueue = new sqs.Queue(this, 'MigrationQueue', {
      queueName: 'chase-imap-migration-queue',
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: migrationDlq,
        maxReceiveCount: 3,
      },
    });

    // CloudWatch alarm for migration DLQ — alert when any messages land in DLQ
    const migrationDlqAlarm = new cloudwatch.Alarm(this, 'MigrationDLQAlarm', {
      alarmName: 'chase-imap-migration-dlq-depth',
      alarmDescription: 'Alert when IMAP migration messages fail after 3 retries',
      metric: migrationDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // =========================================================
    // Lambda — inbound-email-processor
    //
    // Bundled with esbuild. AWS SDK v3 is external (available in
    // Lambda Node.js 22 runtime). mailparser, node-forge, and ulid
    // are bundled into the deployment package.
    // =========================================================
    const ingestFn = new lambdaNode.NodejsFunction(this, 'InboundEmailProcessor', {
      functionName: 'chase-inbound-email-processor',
      description: 'Parse, encrypt, and store inbound emails; notify client via SNS',
      entry: path.join(__dirname, '../lambda/inbound-email-processor/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Reuse the pre-created role rather than letting CDK create a new one.
      // All necessary grants are applied to sesIngestRole above.
      role: sesIngestRole,
      deadLetterQueue: ingestDlq,
      retryAttempts: 2,          // 3 total attempts before event goes to DLQ
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        RAW_EMAIL_BUCKET_NAME: rawEmailBucket.bucketName,
        USER_DATA_BUCKET_NAME: userDataBucket.bucketName,
        EMAILS_TABLE_NAME: emailsTable.tableName,
        USERS_TABLE_NAME: usersTable.tableName,
        // Prefix for per-user SNS topic ARNs.
        // The auth Lambda appends <userId> to this prefix when creating topics.
        SNS_TOPIC_ARN_PREFIX: `arn:aws:sns:${this.region}:${this.account}:chase-email-new-`,
        // VAPID keys for Web Push notifications
        VAPID_PUBLIC_KEY: 'BHcXUrav134nnghNo_bcDCBplzgUDHJ7QCnp5UwdKg4PsS9lBs44QVySFPReuoBQ1tQBSPxyD0o2Bo4NeGz9id8',
        VAPID_PRIVATE_KEY_PARAM: '/chase-email/vapid-private-key',
        // Domain used to identify the local recipient in forwarded emails
        RECIPIENT_DOMAIN: domainName,
        // Admin contact email for VAPID (web push) — used only in the mailto: field
        VAPID_ADMIN_EMAIL: `admin@${domainName}`,
      },
      bundling: {
        // @aws-sdk/* is present in the Lambda Node.js 22 runtime — no need to bundle.
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // =========================================================
    // Lambda — dlq-redrive
    //
    // Manually invoked (console / CLI) to redrive messages from the ingest DLQ
    // back to the inbound-email-processor. Re-invokes the target synchronously
    // so failures stay in the DLQ; successes are deleted.
    // =========================================================
    const dlqRedriveFn = new lambdaNode.NodejsFunction(this, 'DlqRedrive', {
      functionName: 'chase-dlq-redrive',
      description: 'Redrive ingest DLQ messages back to the inbound-email-processor',
      entry: path.join(__dirname, '../lambda/dlq-redrive/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(10),
      memorySize: 256,
      environment: {
        DLQ_URL: ingestDlq.queueUrl,
        TARGET_FUNCTION_NAME: ingestFn.functionName,
        BATCH_SIZE: '10',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // Grant the redrive Lambda permission to read/delete from the DLQ and invoke the target
    ingestDlq.grantConsumeMessages(dlqRedriveFn);
    ingestFn.grantInvoke(dlqRedriveFn);

    // =========================================================
    // Lambda — api-handler
    //
    // Single Lambda handles all HTTP API routes via routeKey dispatch.
    // @aws-sdk/s3-request-presigner is bundled (not in the Lambda runtime);
    // all @aws-sdk/client-* are external (provided by the Node.js 22 runtime).
    // =========================================================
    const apiHandlerFn = new lambdaNode.NodejsFunction(this, 'ApiHandler', {
      functionName: 'chase-api-handler',
      description: 'REST API: registration, key bundle, email list/fetch/flags/send',
      entry: path.join(__dirname, '../lambda/api-handler/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: apiLambdaRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        USERS_TABLE_NAME: usersTable.tableName,
        EMAILS_TABLE_NAME: emailsTable.tableName,
        INVITES_TABLE_NAME: invitesTable.tableName,
        USER_DATA_BUCKET_NAME: userDataBucket.bucketName,
        UPLOAD_BUCKET_NAME: migrationUploadBucket.bucketName,
        MBOX_BUCKET_NAME: migrationMboxBucket.bucketName,
        SES_FROM_DOMAIN: domainName,
        SNS_TOPIC_ARN_PREFIX: `arn:aws:sns:${this.region}:${this.account}:chase-email-new-`,
      },
      bundling: {
        // Exclude SDK clients (in Node.js 22 runtime) but bundle the presigner utility.
        externalModules: ['@aws-sdk/client-*', '@aws-sdk/util-dynamodb'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // =========================================================
    // Lambda — stream-processor
    //
    // Triggered by DynamoDB Streams on emailsTable (OLD_IMAGE).
    // On REMOVE events (TTL expiry or hard deletes), deletes the
    // associated S3 blobs so storage is fully reclaimed.
    // =========================================================
    const streamProcessorRole = new iam.Role(this, 'StreamProcessorRole', {
      roleName: 'chase-stream-processor-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'Stream processor: delete S3 blobs when DynamoDB email items are removed',
    });
    // Delete objects + list (for attachment prefix cleanup)
    userDataBucket.grantDelete(streamProcessorRole);
    userDataBucket.grantRead(streamProcessorRole); // for ListObjectsV2

    const streamProcessorFn = new lambdaNode.NodejsFunction(this, 'StreamProcessor', {
      functionName: 'chase-stream-processor',
      description: 'Delete S3 blobs when email DDB items are removed (TTL expiry / hard delete)',
      entry: path.join(__dirname, '../lambda/stream-processor/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: streamProcessorRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        USER_DATA_BUCKET_NAME: userDataBucket.bucketName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // =========================================================
    // Lambda — unzip-lambda
    //
    // Triggered by S3 ObjectCreated events on migrationUploadBucket.
    // Extracts mbox files from uploaded zip archives and uploads them
    // to migrationMboxBucket for processing.
    // =========================================================
    const unzipLambdaRole = new iam.Role(this, 'UnzipLambdaRole', {
      roleName: 'chase-unzip-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'Unzip Lambda: extract mbox files from zip archives',
    });
    migrationUploadBucket.grantRead(unzipLambdaRole);
    migrationUploadBucket.grantDelete(unzipLambdaRole);
    migrationMboxBucket.grantPut(unzipLambdaRole);
    rawEmailBucket.grantPut(unzipLambdaRole); // For uploading .eml files directly to migration/ prefix
    emailsTable.grantReadWriteData(unzipLambdaRole);

    const unzipFn = new lambdaNode.NodejsFunction(this, 'UnzipLambda', {
      functionName: 'chase-unzip-lambda',
      description: 'Extract mbox files from zip archives and initialize migration state',
      entry: path.join(__dirname, '../lambda/unzip-lambda/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: unzipLambdaRole,
      timeout: cdk.Duration.minutes(10),  // Reduced - just extracting, not processing
      memorySize: 2048,  // Reduced - streaming extraction
      ephemeralStorageSize: cdk.Size.mebibytes(5120),  // 5GB temp storage
      environment: {
        EMAILS_TABLE_NAME: emailsTable.tableName,
        MBOX_BUCKET_NAME: migrationMboxBucket.bucketName,
        UPLOAD_BUCKET_NAME: migrationUploadBucket.bucketName,
        RAW_BUCKET_NAME: rawEmailBucket.bucketName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // =========================================================
    // Lambda — parse-lambda
    //
    // Triggered by S3 ObjectCreated events on migrationMboxBucket.
    // Parses mbox files, extracts individual messages, converts to .eml
    // format, and uploads to rawEmailBucket for processing.
    // =========================================================
    const parseLambdaRole = new iam.Role(this, 'ParseLambdaRole', {
      roleName: 'chase-parse-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'Parse Lambda: parse mbox files and extract individual messages',
    });
    migrationMboxBucket.grantRead(parseLambdaRole);
    rawEmailBucket.grantPut(parseLambdaRole);
    emailsTable.grantReadWriteData(parseLambdaRole);

    // =========================================================
    // SQS — mbox-worker-queue
    // 
    // Queue for parallel processing of mbox message batches.
    // Each message contains metadata for a batch of ~100 email messages.
    // =========================================================
    const mboxWorkerDLQ = new sqs.Queue(this, 'MboxWorkerDLQ', {
      queueName: 'chase-mbox-worker-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const mboxWorkerQueue = new sqs.Queue(this, 'MboxWorkerQueue', {
      queueName: 'chase-mbox-worker-queue',
      visibilityTimeout: cdk.Duration.minutes(5), // Match worker Lambda timeout
      receiveMessageWaitTime: cdk.Duration.seconds(20), // Long polling
      deadLetterQueue: {
        queue: mboxWorkerDLQ,
        maxReceiveCount: 3,
      },
    });

    // =========================================================
    // Lambda — mbox-indexer
    //
    // Triggered by S3 ObjectCreated events on migrationMboxBucket.
    // Scans mbox files to find message boundaries and creates work batches.
    // =========================================================
    const indexerLambdaRole = new iam.Role(this, 'IndexerLambdaRole', {
      roleName: 'chase-mbox-indexer-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'Mbox Indexer Lambda: scan mbox files, create folders/labels, and create work batches',
    });
    migrationMboxBucket.grantRead(indexerLambdaRole);
    emailsTable.grantReadWriteData(indexerLambdaRole);
    usersTable.grantReadData(indexerLambdaRole); // Need to read user's public key for encryption
    mboxWorkerQueue.grantSendMessages(indexerLambdaRole);

    const indexerFn = new lambdaNode.NodejsFunction(this, 'MboxIndexerLambda', {
      functionName: 'chase-mbox-indexer-lambda',
      description: 'Scan mbox files, create encrypted folders/labels, and create work batches',
      entry: path.join(__dirname, '../lambda/mbox-indexer/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: indexerLambdaRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512, // Small Lambda - just scanning for boundaries
      environment: {
        EMAILS_TABLE_NAME: emailsTable.tableName,
        USERS_TABLE_NAME: usersTable.tableName,
        WORKER_QUEUE_URL: mboxWorkerQueue.queueUrl,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // =========================================================
    // Lambda — mbox-worker
    //
    // Triggered by SQS messages from indexer Lambda.
    // Processes batches of messages using S3 byte-range requests.
    // =========================================================
    const workerLambdaRole = new iam.Role(this, 'WorkerLambdaRole', {
      roleName: 'chase-mbox-worker-lambda',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'Mbox Worker Lambda: process message batches using byte-range requests',
    });
    migrationMboxBucket.grantRead(workerLambdaRole);
    rawEmailBucket.grantPut(workerLambdaRole);
    emailsTable.grantReadWriteData(workerLambdaRole);
    usersTable.grantReadData(workerLambdaRole); // Need to read user's public key for encryption

    const workerFn = new lambdaNode.NodejsFunction(this, 'MboxWorkerLambda', {
      functionName: 'chase-mbox-worker-lambda',
      description: 'Process mbox message batches using S3 byte-range requests',
      entry: path.join(__dirname, '../lambda/mbox-worker/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: workerLambdaRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 2048, // Small Lambda - only processes 100 messages at a time
      reservedConcurrentExecutions: 50, // Limit concurrency to avoid overwhelming downstream
      environment: {
        EMAILS_TABLE_NAME: emailsTable.tableName,
        USERS_TABLE_NAME: usersTable.tableName,
        PROCESSING_BUCKET_NAME: rawEmailBucket.bucketName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // Wire SQS → Worker Lambda
    workerFn.addEventSource(new lambdaEventSources.SqsEventSource(mboxWorkerQueue, {
      batchSize: 1, // Process one batch at a time per invocation
      reportBatchItemFailures: true,
    }));

    // Wire DynamoDB Streams → stream processor; filter to REMOVE events only
    streamProcessorFn.addEventSource(new lambdaEventSources.DynamoEventSource(emailsTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      bisectBatchOnError: true,
      retryAttempts: 2,
      filters: [
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('REMOVE') }),
      ],
    }));

    // =========================================================
    // Lambda: Embedding Batch Processor
    // Unpacks batch embedding files and updates DynamoDB.
    // =========================================================
    const embeddingBatchProcessorRole = new iam.Role(this, 'EmbeddingBatchProcessorRole', {
      roleName: 'chase-embedding-batch-processor',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'Embedding Batch Processor: unpack batch files and update DynamoDB',
    });
    userDataBucket.grantRead(embeddingBatchProcessorRole);
    userDataBucket.grantPut(embeddingBatchProcessorRole);
    emailsTable.grantReadWriteData(embeddingBatchProcessorRole);

    const embeddingBatchProcessorFn = new lambdaNode.NodejsFunction(this, 'EmbeddingBatchProcessor', {
      functionName: 'chase-embedding-batch-processor',
      description: 'Unpack batch embedding files and update DynamoDB s3EmbeddingKey fields',
      entry: path.join(__dirname, '../lambda/embedding-batch-processor/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: embeddingBatchProcessorRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        USER_DATA_BUCKET_NAME: userDataBucket.bucketName,
        EMAILS_TABLE_NAME: emailsTable.tableName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // Trigger on batch file uploads
    userDataBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(embeddingBatchProcessorFn),
      { prefix: '', suffix: '/embedding-batches/' },  // Matches {userId}/embedding-batches/*.json
    );

    // =========================================================
    // Lambda: Admin Delete User
    // Manually invoked by admin to delete all user data.
    // =========================================================
    const adminDeleteUserRole = new iam.Role(this, 'AdminDeleteUserRole', {
      roleName: 'chase-admin-delete-user',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      description: 'Admin Delete User: delete all user data from S3 and DynamoDB',
    });
    userDataBucket.grantDelete(adminDeleteUserRole);
    userDataBucket.grantReadWrite(adminDeleteUserRole);  // Needed for ListObjectsV2
    emailsTable.grantReadWriteData(adminDeleteUserRole);
    usersTable.grantReadWriteData(adminDeleteUserRole);
    
    // Grant permission to delete per-user SNS topics
    adminDeleteUserRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowSNSDeleteUserTopics',
      effect: iam.Effect.ALLOW,
      actions: ['sns:DeleteTopic'],
      resources: [`arn:aws:sns:${this.region}:${this.account}:chase-email-new-*`],
    }));

    const adminDeleteUserFn = new lambdaNode.NodejsFunction(this, 'AdminDeleteUser', {
      functionName: 'chase-admin-delete-user',
      description: 'Admin tool: delete all user data from S3 and DynamoDB',
      entry: path.join(__dirname, '../lambda/admin-delete-user/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: adminDeleteUserRole,
      timeout: cdk.Duration.minutes(15),  // May take a while for users with lots of data
      memorySize: 512,
      environment: {
        USER_DATA_BUCKET_NAME: userDataBucket.bucketName,
        EMAILS_TABLE_NAME: emailsTable.tableName,
        USERS_TABLE_NAME: usersTable.tableName,
        SNS_TOPIC_ARN_PREFIX: `arn:aws:sns:${this.region}:${this.account}:chase-email-new-`,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // =========================================================
    // Header Migration Lambda
    // One-time migration to copy headers from S3 to DynamoDB
    // =========================================================
    const headerMigrationRole = new iam.Role(this, 'HeaderMigrationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    
    emailsTable.grantReadWriteData(headerMigrationRole);
    userDataBucket.grantRead(headerMigrationRole);

    const headerMigrationFn = new lambdaNode.NodejsFunction(this, 'HeaderMigration', {
      functionName: 'chase-header-migration',
      description: 'One-time migration: copy email headers from S3 to DynamoDB',
      entry: path.join(__dirname, '../lambda/header-migration/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: headerMigrationRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        USER_DATA_BUCKET: userDataBucket.bucketName,
        EMAILS_TABLE_NAME: emailsTable.tableName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // =========================================================
    // API Gateway HTTP API + JWT Authorizer (Cognito)
    // =========================================================
    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: 'chase-email-api',
      description: 'Chase Email REST API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigatewayv2.CorsHttpMethod.ANY],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.days(1),
      },
    });

    const jwtAuthorizer = new apigatewayv2Authorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );

    const apiIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'ApiIntegration',
      apiHandlerFn,
    );

    // Public route — no JWT required (user doesn't have one yet)
    httpApi.addRoutes({
      path: '/auth/register',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    // Protected routes — JWT required; userId resolved from the `sub` claim
    const protectedRoutes: [apigatewayv2.HttpMethod, string][] = [
      [apigatewayv2.HttpMethod.GET, '/auth/key-bundle'],
      [apigatewayv2.HttpMethod.POST, '/auth/recovery-codes'],
      [apigatewayv2.HttpMethod.GET, '/emails'],
      [apigatewayv2.HttpMethod.POST, '/emails/batch-get'],
      [apigatewayv2.HttpMethod.GET, '/emails/{ulid}/header'],
      [apigatewayv2.HttpMethod.GET, '/emails/{ulid}/body'],
      [apigatewayv2.HttpMethod.GET, '/emails/{ulid}/text'],
      [apigatewayv2.HttpMethod.POST, '/emails/text/batch'],
      [apigatewayv2.HttpMethod.GET, '/emails/{ulid}/embedding'],
      [apigatewayv2.HttpMethod.PUT, '/emails/{ulid}/embedding'],
      [apigatewayv2.HttpMethod.GET, '/emails/{ulid}/attachments'],
      [apigatewayv2.HttpMethod.GET, '/emails/{ulid}/attachment/{attachmentId}'],
      [apigatewayv2.HttpMethod.PUT, '/emails/{ulid}/flags'],
      [apigatewayv2.HttpMethod.POST, '/emails/bulk-update'],
      [apigatewayv2.HttpMethod.DELETE, '/emails/{ulid}'],
      [apigatewayv2.HttpMethod.POST, '/emails/{ulid}/restore'],
      [apigatewayv2.HttpMethod.POST, '/emails/send'],
      [apigatewayv2.HttpMethod.GET, '/counts'],
      [apigatewayv2.HttpMethod.POST, '/push/subscribe'],
      [apigatewayv2.HttpMethod.DELETE, '/push/subscribe'],
      [apigatewayv2.HttpMethod.PUT, '/drafts/{ulid}'],
      [apigatewayv2.HttpMethod.DELETE, '/drafts/{ulid}'],
      [apigatewayv2.HttpMethod.POST, '/attachments/upload-url'],
      [apigatewayv2.HttpMethod.DELETE, '/attachments/{emailId}/{attachmentId}'],
      [apigatewayv2.HttpMethod.GET, '/folders/list'],
      [apigatewayv2.HttpMethod.PUT, '/folders/{folderId}'],
      [apigatewayv2.HttpMethod.DELETE, '/folders/{folderId}'],
      [apigatewayv2.HttpMethod.PUT, '/folders/ordering'],
      [apigatewayv2.HttpMethod.GET, '/labels/list'],
      [apigatewayv2.HttpMethod.PUT, '/labels/{labelId}'],
      [apigatewayv2.HttpMethod.DELETE, '/labels/{labelId}'],
      [apigatewayv2.HttpMethod.GET, '/migration/upload-url'],
      [apigatewayv2.HttpMethod.GET, '/migration/status'],
      [apigatewayv2.HttpMethod.POST, '/migration/cancel'],
      [apigatewayv2.HttpMethod.POST, '/migration/complete'],
      [apigatewayv2.HttpMethod.GET, '/sync'],
      [apigatewayv2.HttpMethod.GET, '/filters'],
      [apigatewayv2.HttpMethod.GET, '/filters/{filterId}'],
      [apigatewayv2.HttpMethod.PUT, '/filters/{filterId}'],
      [apigatewayv2.HttpMethod.DELETE, '/filters/{filterId}'],
      [apigatewayv2.HttpMethod.GET, '/settings'],
      [apigatewayv2.HttpMethod.PUT, '/settings'],
      [apigatewayv2.HttpMethod.GET, '/admin/users'],
      [apigatewayv2.HttpMethod.GET, '/admin/invites'],
      [apigatewayv2.HttpMethod.POST, '/admin/invites'],
      [apigatewayv2.HttpMethod.DELETE, '/admin/invites/{inviteCode}'],
      [apigatewayv2.HttpMethod.POST, '/client-logs'],
    ];
    for (const [method, routePath] of protectedRoutes) {
      httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: apiIntegration,
        authorizer: jwtAuthorizer,
      });
    }

    // =========================================================
    // ACM Certificate + Custom Domain for API Gateway
    // Certificate is DNS-validated automatically via the Route53 hosted zone.
    // =========================================================
    const apiSubdomain = `api.${domainName}`;

    const apiCert = new acm.Certificate(this, 'ApiCertificate', {
      domainName: apiSubdomain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const apiDomainName = new apigatewayv2.DomainName(this, 'ApiDomainName', {
      domainName: apiSubdomain,
      certificate: apiCert,
    });

    new apigatewayv2.ApiMapping(this, 'ApiMapping', {
      api: httpApi,
      domainName: apiDomainName,
    });

    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: hostedZone,
      recordName: 'api',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          apiDomainName.regionalDomainName,
          apiDomainName.regionalHostedZoneId,
        ),
      ),
    });

    // =========================================================
    // S3 Event Notification — incoming/ → ingestFn
    // Only fires for objects created under the incoming/ prefix
    // (the prefix used by the SES receipt rule S3 action).
    // =========================================================
    rawEmailBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(ingestFn),
      { prefix: 'incoming/' },
    );

    // =========================================================
    // S3 Event Notification — migration/ → ingestFn
    // Fires for objects created under the migration/{userId}/ prefix
    // (used by the Parse Lambda to trigger email processing).
    // =========================================================
    rawEmailBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(ingestFn),
      { prefix: 'migration/' },
    );

    // =========================================================
    // S3 Event Notification — uploads/{userId}/ → unzipFn
    // Fires when users upload zip files containing mbox archives.
    // Triggers the Unzip Lambda to extract mbox files.
    // =========================================================
    migrationUploadBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(unzipFn),
      { prefix: 'uploads/' },
    );

    // =========================================================
    // S3 Event Notification — mbox/{userId}/ → indexerFn
    // Fires when mbox files are extracted from zip archives.
    // Triggers the Indexer Lambda to scan files and create work batches.
    // =========================================================
    migrationMboxBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(indexerFn),
      { prefix: 'mbox/' },
    );

    // =========================================================
    // SES — Receipt Rule Set + Receipt Rule
    //
    // Rule: receive mail for domainName → write raw .eml to
    //       rawEmailBucket under the incoming/ prefix.
    //
    // SES spam/virus scanning is enabled so overtly malicious
    // messages are rejected before we ever parse them.
    //
    // ⚠ CfnActiveReceiptRuleSet makes this the active rule set.
    //   If another rule set is already active it will be replaced.
    //   SES inbound email processing is only available in:
    //   us-east-1, us-west-2, eu-west-1, and a small number of other regions.
    // =========================================================
    const receiptRuleSet = new ses.ReceiptRuleSet(this, 'InboundRuleSet', {
      receiptRuleSetName: 'chase-email-inbound',
    });

    new ses.ReceiptRule(this, 'InboundRule', {
      ruleSet: receiptRuleSet,
      receiptRuleName: 'deliver-to-s3',
      recipients: [domainName],   // match any address @domainName
      scanEnabled: true,          // SES spam + virus scanning
      tlsPolicy: ses.TlsPolicy.REQUIRE,
      actions: [
        new sesActions.S3({
          bucket: rawEmailBucket,
          objectKeyPrefix: 'incoming/',
        }),
      ],
    });

    // Activate the rule set via AwsCustomResource (SDK call) because
    // AWS::SES::ActiveReceiptRuleSet is not available as a CFN resource type.
    new cr.AwsCustomResource(this, 'ActivateReceiptRuleSet', {
      resourceType: 'Custom::SESActiveReceiptRuleSet',
      onCreate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: receiptRuleSet.receiptRuleSetName },
        physicalResourceId: cr.PhysicalResourceId.of('ses-active-receipt-rule-set'),
      },
      onUpdate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: receiptRuleSet.receiptRuleSetName },
        physicalResourceId: cr.PhysicalResourceId.of('ses-active-receipt-rule-set'),
      },
      // Deactivate the rule set on delete so CloudFormation can cleanly remove the CfnReceiptRuleSet.
      onDelete: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: {}, // omitting RuleSetName deactivates the currently active rule set
        physicalResourceId: cr.PhysicalResourceId.of('ses-active-receipt-rule-set'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ses:SetActiveReceiptRuleSet'],
          resources: ['*'],
        }),
      ]),
    });

    // =========================================================
    // S3 — Web Client Bucket
    // Hosts the compiled React SPA. CloudFront OAC provides access.
    // Deploy with: aws s3 sync dist/ s3://<bucket> --delete
    // =========================================================
    const webBucket = new s3.Bucket(this, 'WebClientBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // =========================================================
    // CloudFront — Web Client Distribution
    //
    // ACM cert must be in us-east-1 for CloudFront; DnsValidatedCertificate
    // handles the cross-region creation from this us-west-2 stack.
    //
    // COOP + COEP headers are required for SharedArrayBuffer / WASM
    // (used by @sqlite.org/sqlite-wasm and @xenova/transformers).
    // =========================================================
    const webCert = new DnsValidatedCertificate(this, 'WebCertificate', {
      domainName,
      hostedZone,
      region: 'us-east-1', // CloudFront requires us-east-1
      cleanupRoute53Records: true,
    });

    const webSecurityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'WebSecurityHeaders', {
      responseHeadersPolicyName: 'chase-web-security-headers',
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
          // 'require-corp' has universal browser support; 'credentialless' (Chrome 96+)
          // is not recognised by older Android Chrome/WebView and leaves crossOriginIsolated=false,
          // which makes SharedArrayBuffer unavailable and breaks sqlite-wasm initialisation.
          { header: 'Cross-Origin-Embedder-Policy', value: 'require-corp', override: true },
        ],
      },
    });

    const webDistribution = new cloudfront.Distribution(this, 'WebDistribution', {
      domainNames: [domainName],
      certificate: webCert,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: webSecurityHeaders,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        // SPA fallback — unknown routes return index.html with 200
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // Zone-apex A record → CloudFront
    new route53.ARecord(this, 'WebAliasRecord', {
      zone: hostedZone,
      // no recordName → zone apex (wilsonhq.net)
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(webDistribution),
      ),
    });

    // =========================================================
    // SSM Parameter Store
    // =========================================================
    const toKebab = (s: string) =>
      s
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/([a-z\d])([A-Z])/g, '$1-$2')
        .toLowerCase();

    const p = (name: string, value: string) =>
      new ssm.StringParameter(this, `SSM${name}`, {
        parameterName: `/chase-email/${toKebab(name)}`,
        stringValue: value,
        description: `Chase Email — ${name}`,
      });

    // Phase 1 resources
    p('RawEmailBucketName', rawEmailBucket.bucketName);
    p('RawEmailBucketArn', rawEmailBucket.bucketArn);
    p('UserDataBucketName', userDataBucket.bucketName);
    p('UserDataBucketArn', userDataBucket.bucketArn);
    p('MigrationUploadBucketName', migrationUploadBucket.bucketName);
    p('MigrationUploadBucketArn', migrationUploadBucket.bucketArn);
    p('MigrationMboxBucketName', migrationMboxBucket.bucketName);
    p('MigrationMboxBucketArn', migrationMboxBucket.bucketArn);
    p('EmailsTableName', emailsTable.tableName);
    p('EmailsTableArn', emailsTable.tableArn);
    p('UsersTableName', usersTable.tableName);
    p('UsersTableArn', usersTable.tableArn);
    p('SESIngestLambdaRoleArn', sesIngestRole.roleArn);
    p('APILambdaRoleArn', apiLambdaRole.roleArn);
    p('AuthLambdaRoleArn', authLambdaRole.roleArn);
    p('HostedZoneId', hostedZone.hostedZoneId);
    p('DomainName', domainName);

    // Phase 2 resources
    p('InboundEmailProcessorArn', ingestFn.functionArn);
    p('InboundEmailProcessorName', ingestFn.functionName);
    p('SESReceiptRuleSetName', receiptRuleSet.receiptRuleSetName);
    p('SNSTopicArnPrefix', `arn:aws:sns:${this.region}:${this.account}:chase-email-new-`);

    // Phase 3 resources
    p('InvitesTableName', invitesTable.tableName);
    p('InvitesTableArn', invitesTable.tableArn);
    p('UserPoolId', userPool.userPoolId);
    p('UserPoolArn', userPool.userPoolArn);
    p('UserPoolClientId', userPoolClient.userPoolClientId);
    p('ApiHandlerArn', apiHandlerFn.functionArn);
    p('ApiUrl', `https://${apiSubdomain}`);

    // Phase 3.5 resources
    p('WebBucketName', webBucket.bucketName);
    p('WebDistributionId', webDistribution.distributionId);
    p('WebUrl', `https://${domainName}`);

    // IMAP Migration resources
    p('MigrationQueueUrl', migrationQueue.queueUrl);
    p('MigrationQueueArn', migrationQueue.queueArn);
    p('MigrationDLQUrl', migrationDlq.queueUrl);
    p('MigrationDLQArn', migrationDlq.queueArn);

    // Mbox Migration resources
    p('UnzipLambdaArn', unzipFn.functionArn);
    p('UnzipLambdaName', unzipFn.functionName);
    p('IndexerLambdaArn', indexerFn.functionArn);
    p('IndexerLambdaName', indexerFn.functionName);
    p('WorkerLambdaArn', workerFn.functionArn);
    p('WorkerLambdaName', workerFn.functionName);

    // =========================================================
    // CloudFormation Outputs
    // =========================================================
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: hostedZone.hostedZoneId,
      description: 'Route 53 Hosted Zone ID',
    });
    if (ownedZone) {
      new cdk.CfnOutput(this, 'HostedZoneNameServers', {
        value: cdk.Fn.join(', ', ownedZone.hostedZoneNameServers!),
        description: '⚠ Update your domain registrar with these name servers',
      });
    }
    new cdk.CfnOutput(this, 'RawEmailBucketName', { value: rawEmailBucket.bucketName });
    new cdk.CfnOutput(this, 'UserDataBucketName', { value: userDataBucket.bucketName });
    new cdk.CfnOutput(this, 'MigrationUploadBucketName', {
      value: migrationUploadBucket.bucketName,
      description: 'S3 bucket for migration zip file uploads',
    });
    new cdk.CfnOutput(this, 'MigrationMboxBucketName', {
      value: migrationMboxBucket.bucketName,
      description: 'S3 bucket for extracted mbox files',
    });
    new cdk.CfnOutput(this, 'EmailsTableName', { value: emailsTable.tableName });
    new cdk.CfnOutput(this, 'UsersTableName', { value: usersTable.tableName });
    new cdk.CfnOutput(this, 'SESIngestRoleArn', { value: sesIngestRole.roleArn });
    new cdk.CfnOutput(this, 'APILambdaRoleArn', { value: apiLambdaRole.roleArn });
    new cdk.CfnOutput(this, 'AuthLambdaRoleArn', { value: authLambdaRole.roleArn });
    new cdk.CfnOutput(this, 'InboundEmailProcessorArn', {
      value: ingestFn.functionArn,
      description: 'Phase 2 ingest Lambda ARN',
    });
    new cdk.CfnOutput(this, 'SESReceiptRuleSetName', {
      value: receiptRuleSet.receiptRuleSetName,
    });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${apiSubdomain}`,
      description: 'Base URL for the Chase Email REST API',
    });
    new cdk.CfnOutput(this, 'InvitesTableName', { value: invitesTable.tableName });
    new cdk.CfnOutput(this, 'WebBucketName', { value: webBucket.bucketName });
    new cdk.CfnOutput(this, 'WebDistributionId', { value: webDistribution.distributionId });
    new cdk.CfnOutput(this, 'WebUrl', {
      value: `https://${domainName}`,
      description: 'Web client URL',
    });
  }
}
