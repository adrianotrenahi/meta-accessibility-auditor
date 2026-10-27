# First paid test

On 27 October 2026, Adriano approved one paid test. It used the new controlled shop, the new project's local records and Standard Muse Spark 1.3, with a $3 ceiling from the $150 allowance. No Cavioo data or services were used. A first request-format attempt stopped at token counting before any generation; the unsupported named tool choice was corrected and the count endpoint accepted the request. The paid test below is the only run that sent generation requests.

## Impact on the system

The paid run sent eleven generation requests: six driver, two analyst and three reviewer. All returned completed results, with no unknown request charges. Reported usage was 193,032 input tokens and 17,226 output tokens; cached input was zero. Applying [Meta's published Standard rates](https://dev.meta.ai/docs/pricing-rate-limits) gives a usage-based estimate of $0.3145005, about $0.31 against the $3 ceiling. This is a calculation from reported usage, not a reconciled provider invoice. The application's conservative rounded record is $0.314504.

Six actual keyboard actions added the bag and opened the basket. Seven original captures were saved. Before continuing to the review form, the driver request exceeded its evidence input allowance and the run stopped as partial. The shared store retained the original evidence and final review. No request was silently retried, and the temporary spending approval was removed. Further paid runs remain disabled.

## Impact on the UX

The viewer received four published cards representing two repeated claims. The missing accessible name is supported by the original element data, actual keyboard focus and automatic measurements. The separate visual judgement about a '+' label needs narrower wording: the title says there is no visible context, although the original image includes the product name, description and price. An expert concern about ambiguity does not establish absence of that surrounding context. The original model findings are preserved, including this problem; the test is not an accuracy pass.

The model supplied no target identifier for any candidate, so the current matching condition never invoked SAM. Zero SAM calls do not establish a segmentation result. Native VoiceOver was explicitly not tested in this headless Chromium run; neither keyboard success nor browser metadata is claimed as real spoken output.

## Still pending

- **Codex:** select relevant original evidence within the request allowance while preserving access to the whole shared store; repeated original images must not force a short journey to stop.
- **Codex:** consolidate repeated claims, require supported wording throughout each finding and ensure element-specific claims include the exact target needed by SAM.
- **Codex and Adriano:** complete and independently evaluate the full journey, SAM matching and real VoiceOver operation. This run does not establish the planned two successes in three attempts or an improvement over Cavioo.
- **Adriano:** provider Billing reconciliation and a new bounded approval before any further paid test. This test used about 0.21% of the confirmed $150 allowance by the usage-based estimate.
