import {
  PRODUCT_DEPENDENCIES,
  PRODUCT_KEYS,
  optionsOf,
  type ProductDependencies,
  type ProductKey,
  type ProductRequirement,
} from './products';

/**
 * Questions about the product dependency graph. Every function takes the
 * dependencies as its last argument, defaulting to the real ones, so tests can
 * pass a small graph of their own.
 */

/** A requirement of `product` that the selection does not meet. */
export interface MissingRequirement {
  product: ProductKey;
  requirement: ProductRequirement;
}

const isMet = (
  requirement: ProductRequirement,
  selected: ReadonlySet<ProductKey>,
): boolean => optionsOf(requirement).some((option) => selected.has(option));

/**
 * What is wrong with a set of products, if anything. An empty list means the
 * business may hold exactly this set.
 */
export const findMissingRequirements = (
  selection: readonly ProductKey[],
  dependencies: ProductDependencies = PRODUCT_DEPENDENCIES,
): MissingRequirement[] => {
  const selected = new Set(selection);
  const missing: MissingRequirement[] = [];
  for (const product of selected) {
    for (const requirement of dependencies[product]) {
      if (!isMet(requirement, selected)) {
        missing.push({ product, requirement });
      }
    }
  }
  return missing;
};

export interface ResolvedSelection {
  /** The original selection plus everything that had to be added, in catalog order. */
  products: ProductKey[];
  /** Products added because something selected requires them. */
  added: ProductKey[];
  /**
   * Requirements that only the user can settle, because any one of several
   * products would do and none is selected. The plan builder asks.
   */
  choices: MissingRequirement[];
}

/**
 * Completes a selection: adds every product that is required outright, and
 * the requirements of those, until nothing more follows. An "any one of"
 * requirement is never decided here. It is returned in `choices`.
 */
export const resolveSelection = (
  selection: readonly ProductKey[],
  dependencies: ProductDependencies = PRODUCT_DEPENDENCIES,
): ResolvedSelection => {
  const selected = new Set(selection);
  const added = new Set<ProductKey>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const product of [...selected]) {
      for (const requirement of dependencies[product]) {
        if (typeof requirement === 'string' && !selected.has(requirement)) {
          selected.add(requirement);
          added.add(requirement);
          changed = true;
        }
      }
    }
  }

  const inCatalogOrder = (products: ReadonlySet<ProductKey>): ProductKey[] =>
    PRODUCT_KEYS.filter((key) => products.has(key));

  return {
    products: inCatalogOrder(selected),
    added: inCatalogOrder(added),
    choices: findMissingRequirements([...selected], dependencies),
  };
};

/**
 * The selected products that would be left with an unmet requirement if
 * `product` were removed, directly or through another product that goes with
 * it. Removal is refused while this list is not empty.
 *
 * A product that needs "sales or purchases" is not a dependant of sales as
 * long as purchases stays selected.
 */
export const dependantsOf = (
  product: ProductKey,
  selection: readonly ProductKey[],
  dependencies: ProductDependencies = PRODUCT_DEPENDENCIES,
): ProductKey[] => {
  const remaining = new Set(selection);
  remaining.delete(product);
  const dependants = new Set<ProductKey>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of [...remaining]) {
      const broken = dependencies[candidate].some(
        (requirement) => !isMet(requirement, remaining),
      );
      if (broken) {
        remaining.delete(candidate);
        dependants.add(candidate);
        changed = true;
      }
    }
  }
  return PRODUCT_KEYS.filter((key) => dependants.has(key));
};

/**
 * Every dependency cycle in the graph, each as the list of products on it.
 * An "any one of" requirement counts as an edge to each of its options: if
 * any path can loop, it is reported.
 *
 * The real graph must have none. A cycle would mean two products each need
 * the other, so neither could be enabled first.
 */
export const findCycles = (
  dependencies: ProductDependencies = PRODUCT_DEPENDENCIES,
): ProductKey[][] => {
  const keys = Object.keys(dependencies) as ProductKey[];
  const state = new Map<ProductKey, 'visiting' | 'done'>();
  const path: ProductKey[] = [];
  const cycles: ProductKey[][] = [];

  const visit = (product: ProductKey): void => {
    state.set(product, 'visiting');
    path.push(product);
    for (const requirement of dependencies[product]) {
      for (const next of optionsOf(requirement)) {
        if (state.get(next) === 'visiting') {
          cycles.push(path.slice(path.indexOf(next)));
        } else if (state.get(next) === undefined) {
          visit(next);
        }
      }
    }
    path.pop();
    state.set(product, 'done');
  };

  for (const key of keys) {
    if (state.get(key) === undefined) {
      visit(key);
    }
  }
  return cycles;
};

/**
 * The products ordered so that each comes after everything it can depend on.
 * Used wherever work must happen dependencies-first, such as running
 * migrations. Throws if the graph has a cycle.
 */
export const dependencyOrder = (
  dependencies: ProductDependencies = PRODUCT_DEPENDENCIES,
): ProductKey[] => {
  if (findCycles(dependencies).length > 0) {
    throw new Error('The product dependency graph has a cycle.');
  }
  const keys = Object.keys(dependencies) as ProductKey[];
  const ordered: ProductKey[] = [];
  const placed = new Set<ProductKey>();

  const place = (product: ProductKey): void => {
    if (placed.has(product)) {
      return;
    }
    placed.add(product);
    for (const requirement of dependencies[product]) {
      for (const option of optionsOf(requirement)) {
        place(option);
      }
    }
    ordered.push(product);
  };
  keys.forEach(place);
  return ordered;
};
