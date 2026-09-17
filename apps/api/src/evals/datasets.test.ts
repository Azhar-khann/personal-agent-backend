import { describe, expect, it } from "vitest";

import { catalogueFromSeed } from "../agent/catalogue.js";
import { datasets, loadExamples } from "./datasets.js";

describe("eval datasets", () => {
  for (const dataset of datasets(catalogueFromSeed())) {
    it(`${dataset.key} has §11's size and only valid labels`, () => {
      const { examples, problems } = loadExamples(dataset);
      expect(problems).toEqual([]);
      expect(examples).toHaveLength(dataset.size);
    });
  }
});
