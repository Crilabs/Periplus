import { setTransport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { MockImageModel } from "@/lib/ai/mock-image";
import { setImageModelFactory } from "@/lib/pipeline/images/model";

// Code that takes its transport from getTransport() (job handlers) replays recorded responses under test.
setTransport(fixtureTransport());
// The image plan (`imageTargets`) targets places only while an image model is usable (`imageModelAvailable`): tests
// count as a worker with one. Tests of the pipeline pass their own model to `generatePlaceImage`; a test of the
// no-key path sets the factory to undefined and restores this one.
setImageModelFactory(() => new MockImageModel(() => new Error("the test must pass its own image model to generatePlaceImage")));
