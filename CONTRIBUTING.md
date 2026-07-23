# Contributing to Swob

Thank you for contributing to Swob. By submitting a contribution, you agree that it is licensed under the [Apache License 2.0](LICENSE).

## Developer Certificate of Origin

Swob uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (DCO). Every commit must include a `Signed-off-by` trailer certifying that you have the right to submit the work under this project's license.

Create the trailer with Git's `-s` flag:

```bash
git commit -s -m "feat: describe the change"
```

The trailer must use your real name and an email address you control. Pull requests with unsigned commits cannot be merged.

## Contribution flow

1. Open an issue first for security-sensitive, high-risk, or large changes. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
2. Create a focused branch and keep the change narrowly scoped.
3. Run `npm test` and any relevant end-to-end tests.
4. Ensure every commit carries the DCO `Signed-off-by` trailer.
5. Open a pull request that explains the problem, the chosen approach, and how it was verified.

Never include transcripts, credentials, cookies, private paths, customer data, or other sensitive material in fixtures, screenshots, logs, commits, or pull requests.
