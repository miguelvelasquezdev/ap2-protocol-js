import type { Artifact, DataPart } from "@a2a-js/sdk";

/**
 * Extracts and validates canonical objects from A2A artifacts by data key.
 *
 * Searches through artifact parts for DataParts that contain the specified
 * key, then validates each match with the provided schema.
 *
 * @param artifacts - The A2A artifacts to search
 * @param dataKey - The data key to look for (e.g., "ap2.mandates.CartMandate")
 * @param schema - A Zod-style schema with a `parse` method for validation
 * @returns An array of validated objects
 */
export function findCanonicalObjects<T>(
  artifacts: Artifact[],
  dataKey: string,
  schema: { parse: (data: unknown) => T }
): T[] {
  const canonicalObjects: T[] = [];

  for (const artifact of artifacts) {
    for (const part of artifact.parts) {
      if (part.kind === "data") {
        const data = (part as DataPart).data as Record<string, unknown>;
        if (data[dataKey]) {
          try {
            const validatedObject = schema.parse(data[dataKey]);
            canonicalObjects.push(validatedObject);
          } catch (error) {
            console.warn(`Failed to validate object for key ${dataKey}:`, error);
          }
        }
      }
    }
  }

  return canonicalObjects;
}

/**
 * Returns the data from the first DataPart found across all artifacts.
 */
export const getFirstDataPart = (
  artifacts: Artifact[]
): Record<string, unknown> => {
  for (const artifact of artifacts) {
    for (const part of artifact.parts) {
      if (part.kind === "data") {
        return (part as DataPart).data as Record<string, unknown>;
      }
    }
  }
  return {};
};
