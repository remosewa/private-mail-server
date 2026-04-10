#!/bin/bash
# Deploy the web client to S3 and invalidate CloudFront.
# Reads the S3 bucket name and CloudFront distribution ID from CDK stack outputs.

set -e

# Resolve the repo root regardless of where the script is invoked from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

STACK_NAME="ChaseEmailStack"
REGION="${AWS_DEFAULT_REGION:-us-west-2}"

echo "Fetching CDK stack outputs from $STACK_NAME..."

BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebBucketName'].OutputValue" \
  --output text)

DISTRIBUTION=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebDistributionId'].OutputValue" \
  --output text)

if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
  echo "Error: Could not find WebBucketName output in stack $STACK_NAME"
  echo "Make sure you have deployed the backend first: npm run deploy:backend"
  exit 1
fi

if [ -z "$DISTRIBUTION" ] || [ "$DISTRIBUTION" = "None" ]; then
  echo "Error: Could not find WebDistributionId output in stack $STACK_NAME"
  exit 1
fi

echo "Building web client..."
cd "$REPO_ROOT/web-client" && npm run build && cd "$REPO_ROOT"

echo "Syncing to s3://$BUCKET..."
aws s3 sync "$REPO_ROOT/web-client/dist/" "s3://$BUCKET" --delete

echo "Invalidating CloudFront distribution $DISTRIBUTION..."
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths '/*'

echo "Frontend deployed successfully."
