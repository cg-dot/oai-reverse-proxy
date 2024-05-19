# Proof-of-work Verification

You can require users to complete a proof-of-work before they can access the
proxy. This can increase the cost of denial of service attacks and slow down
automated abuse.

When configured, users access the challenge UI and request a proof of work. The
server will generate a challenge according to the difficulty level you have set.
The user can then start the worker to solve the challenge. Once the challenge is
solved, the user can submit the solution to the server. The server will verify
the solution and issue a temporary token for that user.

## Configuration

To enable proof-of-work verification, set the following environment variables:

```
GATEKEEPER=user_token
CAPTCHA_MODE=proof_of_work
# Validity of the token in hours
POW_TOKEN_HOURS=24
# Max number of IPs that can use a user_token issued via proof-of-work
POW_TOKEN_MAX_IPS=2
# The difficulty level of the proof-of-work challenge
POW_DIFFICULTY_LEVEL=low
```

## Difficulty Levels

The difficulty level controls how long it takes to solve the proof-of-work,
specifically by adjusting the average number of iterations required to find a
valid solution. Due to randomness, the actual number of iterations required can
vary significantly.

You can adjust the difficulty while the proxy is running from the admin interface.

### Extreme

- Average of 4000 iterations required
- Not recommended unless you are expecting very high levels of abuse

### High

- Average of 1900 iterations required

### Medium

- Average of 900 iterations required

### Low

- Average of 200 iterations required
- Default setting.

## Custom argon2id parameters

You can set custom argon2id parameters for the proof-of-work challenge.
Generally, you should not need to change these unless you have a specific
reason to do so.

The listed values are the defaults.

```
ARGON2_TIME_COST=8
ARGON2_MEMORY_KB=65536
ARGON2_PARALLELISM=1
ARGON2_HASH_LENGTH=32
```

Increasing parallelism will not do much except increase memory consumption for
both the client and server, because browser proof-of-work implementations are
single-threaded. It's better to increase the time cost if you want to increase
the difficulty.

Increasing memory too much may cause memory exhaustion on some mobile devices,
particularly on iOS due to the way Safari handles WebAssembly memory allocation.

## Tested hash rates

These were measured with the default argon2id parameters listed above. These
tests were not at all scientific so take them with a grain of salt.

Safari does not like large WASM memory usage, so concurrency is limited to 4 to
avoid overallocating memory on mobile WebKit browsers. Thermal throttling can
also significantly reduce hash rates on mobile devices.

- Intel Core i9-13900K (Chrome): 33-35 H/s
- Intel Core i9-13900K (Firefox): 29-32 H/s
- Intel Core i9-13900K (Chrome, in VM limited to 4 cores): 12.2 - 13.0 H/s
- iPad Pro (M2) (Safari, 6 workers): 8.0 - 10 H/s
  - Thermal throttles early. 8 cores is normal concurrency, but unstable.
- iPhone 13 Pro (Safari): 4.0 - 4.6 H/s
- Samsung Galaxy S10e (Chrome): 3.6 - 3.8 H/s
  - This is a 2019 phone almost matching an iPhone five years newer because of
    bad Safari performance.
