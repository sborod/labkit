import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}

test("SDK source dependencies never escape into a laboratory or its build tooling", async () => {
  const violations: string[] = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const check = (specifier: ts.Expression | undefined): void => {
      if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith("."))
        return;
      const target = resolve(dirname(file), specifier.text);
      if (target !== sourceRoot && !target.startsWith(sourceRoot + sep)) {
        violations.push(`${relative(sourceRoot, file)} → ${specifier.text}`);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        check(node.moduleSpecifier);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        check(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
