# Kora configuration recommendation

## Current recommendation

For broad program compatibility, merge these settings into the existing `[validation]` section of your stock Kora configuration:

```toml
[validation]
allowed_programs = "All"
max_allowed_lamports = 250000000 # 0.25 SOL
```

These are configuration fragments, not complete startup files. Retain the required methods, NEIRO reimbursement mint, chosen pricing, signer configuration and fee-payer policies. Our existing operator uses margin pricing; this recommendation does not change its markup. Validate the complete file with `kora --config kora.toml config validate` before restarting.

`All` removes the program-ID allowlist, including for unknown programs and routed venues. It does not make arbitrary programs safe for the sponsor. Stock Kora still applies its other validation and payment checks, but its existing fee-payer permissions do not establish a general arbitrary-program safety boundary. This gap is tracked in [upstream #683](https://github.com/solana-foundation/kora/issues/683).

0.25 SOL is the selected per-transaction lamport allowance, not a daily budget, a universal cost requirement or a guarantee of total loss being capped at that amount. Kora validates estimated network fees separately from modeled fee-payer outflow. Applications must quote the complete transaction, including sponsored rent, and obtain approval for the final payment. See [upstream fee calculation](https://github.com/solana-foundation/kora/blob/v2.2.0-beta.8/crates/lib/src/transaction/versioned_transaction.rs).

This recommendation does not claim measured 90% signing success, compatibility with every transaction, or protection against users signing wallet-draining transactions. Application preparation, payer funding, parsers, token policies, signatures and other Kora limits still affect acceptance.

## Prepared recommendation after #683 ships

As checked on 2 October 2026, [PR #692](https://github.com/solana-foundation/kora/pull/692) is open and is not part of a released stock Kora build. Keep the current configuration until an upstream release includes this feature. Do not install a custom fork or assume an unknown TOML field activates the proposed protection.

After the feature ships, replace the current program setting with the following fragment and retain the 0.25 SOL allowance:

```toml
[validation]
allowed_programs = [
    "11111111111111111111111111111111",             # System
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  # SPL Token
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  # Token-2022
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", # Associated Token
    "ComputeBudget111111111111111111111111111111",  # Compute Budget
    "AddressLookupTab1e1111111111111111111111111",   # Address Lookup Table
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  # Jupiter v6
]
sponsor_only_programs = "All"
max_allowed_lamports = 250000000 # 0.25 SOL
```

Under the proposal, arbitrary outer and inner program IDs can run, but an unapproved program's top-level instruction cannot include Kora's fee-payer account. Jupiter stays in the trusted list because an observed sponsored Jupiter build includes the sponsor in the Jupiter instruction. The trusted list is therefore a list of programs allowed to receive the sponsor account, rather than an inventory of every routed venue. Keep the existing role-specific fee-payer policies as well.

Do not leave `allowed_programs = "All"` in the migrated configuration: the proposal explicitly leaves the sponsor-participation gate disabled in that mode. Sponsor-funded app-owned account creation or other sponsor participation can require additional reviewed programs. Trust in an approved outer program includes its handling of downstream calls; this is not an audit of every routed venue.

Before activating the migrated recommendation, verify the upstream release and its final setting semantics, validate the complete config with that release, and check ordinary sponsored transactions and refusal of unapproved sponsor participation. Publish the verified release version with the updated recommendation. No future version number is assumed here.

## Checked application paths

Five unsigned Jupiter builds passed the proposed static participation check with the six core programs plus Jupiter trusted. The returned routes included Meteora DLMM, GoonFi V2, Raydium, Manifest, Raydium CLMM, Whirlpool, JupLend AMM and Kipseli. These checks examined returned instruction accounts; they were not signed, submitted or tested for complete Kora acceptance. Jupiter supports an integrator payer, and its sponsored `/order` flow routes through Metis. [Jupiter gasless documentation](https://developers.jup.ag/docs/swap/advanced/gasless).

GUM Universal Deposit's ordinary sender transaction uses core SOL/SPL transfer and token-account instructions. Its current hosted widget requires the connected user to be the transaction fee payer, so changing Kora config alone does not make that widget gasless. GUM's separate bank, inbox and outbox processing is not part of the ordinary sender deposit. [GUM wallet-deposit documentation](https://docs.gum.ag/universal-deposit/embed).

Token-2022 metadata reconstruction is separately tracked in [upstream #681](https://github.com/solana-foundation/kora/issues/681). #683 should not be described as fixing that issue or every launch, account-creation or application-integration limitation.
