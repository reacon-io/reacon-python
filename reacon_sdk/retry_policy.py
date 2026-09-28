# Generated from the reviewed Reacon retry policy.
AUDITED_READS = ["/v1/whoami","/v1/domains/[^/]+/counts","/v1/teams/[^/]+/leads"]
RETRYABLE_STATUSES = [429,502,503,504]
MAXIMUM_RETRIES = 3
