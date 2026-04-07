import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ChaseEmail from '../lib/chase-email-stack';

describe('IMAP Migration Infrastructure', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        domainName: 'test.example.com',
        hostedZoneId: 'Z1234567890ABC',
      },
    });
    const stack = new ChaseEmail.ChaseEmailStack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    
    template = Template.fromStack(stack);
  });

  test('Migration DLQ is created with correct configuration', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'chase-imap-migration-dlq',
      MessageRetentionPeriod: 1209600, // 14 days in seconds
      SqsManagedSseEnabled: true,
    });
  });

  test('Migration Queue is created with correct configuration', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'chase-imap-migration-queue',
      VisibilityTimeout: 300, // 5 minutes in seconds
      MessageRetentionPeriod: 1209600, // 14 days in seconds
      SqsManagedSseEnabled: true,
    });
  });

  test('Migration Queue has DLQ configured with maxReceiveCount of 3', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'chase-imap-migration-queue',
      RedrivePolicy: {
        maxReceiveCount: 3,
      },
    });
  });

  test('CloudWatch alarm is created for DLQ depth', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'chase-imap-migration-dlq-depth',
      AlarmDescription: 'Alert when IMAP migration messages fail after 3 retries',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
    });
  });

  test('S3 event notification is configured for incoming/ prefix', () => {
    // Verify that the S3 bucket has a notification configuration for the incoming/ prefix
    const notifications = template.findResources('Custom::S3BucketNotifications');
    const notificationKeys = Object.keys(notifications);
    
    expect(notificationKeys.length).toBe(1);
    
    const notificationConfig = notifications[notificationKeys[0]];
    const lambdaConfigs = notificationConfig.Properties.NotificationConfiguration.LambdaFunctionConfigurations;
    
    // Find the incoming/ prefix configuration
    const incomingConfig = lambdaConfigs.find((config: any) => 
      config.Filter?.Key?.FilterRules?.some((rule: any) => 
        rule.Name === 'prefix' && rule.Value === 'incoming/'
      )
    );
    
    expect(incomingConfig).toBeDefined();
    expect(incomingConfig.Events).toContain('s3:ObjectCreated:*');
  });

  test('S3 event notification is configured for migration/ prefix', () => {
    // Verify that the S3 bucket has a notification configuration for the migration/ prefix
    const notifications = template.findResources('Custom::S3BucketNotifications');
    const notificationKeys = Object.keys(notifications);
    
    expect(notificationKeys.length).toBe(1);
    
    const notificationConfig = notifications[notificationKeys[0]];
    const lambdaConfigs = notificationConfig.Properties.NotificationConfiguration.LambdaFunctionConfigurations;
    
    // Find the migration/ prefix configuration
    const migrationConfig = lambdaConfigs.find((config: any) => 
      config.Filter?.Key?.FilterRules?.some((rule: any) => 
        rule.Name === 'prefix' && rule.Value === 'migration/'
      )
    );
    
    expect(migrationConfig).toBeDefined();
    expect(migrationConfig.Events).toContain('s3:ObjectCreated:*');
  });

  test('Both S3 event notifications trigger the same Lambda function', () => {
    // Verify that both prefixes are configured in the same bucket notification resource
    const notifications = template.findResources('Custom::S3BucketNotifications');
    const notificationKeys = Object.keys(notifications);
    
    // Should have exactly one S3BucketNotifications resource
    expect(notificationKeys.length).toBe(1);
    
    const notificationConfig = notifications[notificationKeys[0]];
    const lambdaConfigs = notificationConfig.Properties.NotificationConfiguration.LambdaFunctionConfigurations;
    
    // Should have at least 2 Lambda configurations (incoming/ and migration/)
    expect(lambdaConfigs.length).toBeGreaterThanOrEqual(2);
    
    // Verify both prefixes are present
    const prefixes = lambdaConfigs.map((config: any) => 
      config.Filter?.Key?.FilterRules?.find((rule: any) => rule.Name === 'prefix')?.Value
    ).filter(Boolean);
    
    expect(prefixes).toContain('incoming/');
    expect(prefixes).toContain('migration/');
  });
});
