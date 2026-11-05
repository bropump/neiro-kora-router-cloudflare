The listing verifier comes from bropump/neiro-payment-network,
commit ad146fcc9b84169024cfdd39590936ec54e25a18, tools/kora-publisher/client.

Adaptations: explicit node:buffer import for Workers; validatePrice and its parsing
helpers extracted from verify-quote.mjs into price-format.mjs. Signature, schema
and anchor validation are unchanged. No quote-pricing calculation, publication,
wallet or signing code is included.
