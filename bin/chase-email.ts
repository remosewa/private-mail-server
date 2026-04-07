#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PrivateMailStack } from '../lib/chase-email-stack';

const app = new cdk.App();

new PrivateMailStack(app, 'ChaseEmailStack', {
  // Requires explicit environment so Route 53 / SES DKIM custom resources work.
  // Pass via: cdk deploy --context domainName=example.com
  // or set CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION in your shell.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-west-2',
  },
  description: 'Private Mail Server — serverless end-to-end encrypted email infrastructure',
});
