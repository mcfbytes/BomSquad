// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default tseslint.config(
  {
    // Generated or vendored trees are never linted. Patterns are relative to this file,
    // so each workspace's own build output needs its own entry — 'dist/' covers the root
    // one only, and `tsc -p pipeline` writes to pipeline/dist, whose emitted .d.ts files
    // are in no tsconfig and so fail the typed-lint project service outright.
    ignores: [
      'node_modules/',
      'dist/',
      '.cache/',
      'extract/',
      'coverage/',
      'pipeline/dist/',
      'site/.angular/',
      'site/dist/',
    ],
  },

  // Scoped to script files only. Angular HTML templates are parsed by
  // angular-eslint/template-parser, which cannot supply type information — letting
  // the type-checked TS presets reach them crashes the run.
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Forward-compatibility with the TypeScript 7 native compiler: nothing in
      // this repo may rely on type-directed emit.
      '@typescript-eslint/no-namespace': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Enums are not erasable. Use a const object plus a union type.',
        },
        {
          selector: 'TSParameterProperty',
          message:
            'Parameter properties are not erasable. Declare the field and assign in the body.',
        },
      ],

      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // --- Angular workspace -----------------------------------------------------
  {
    files: ['site/**/*.ts'],
    extends: [angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      // A standalone component whose behaviour lives entirely in its template is
      // idiomatic Angular, not a code smell.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['site/**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
  },
  {
    // Angular's TestBed surface is deliberately loosely typed; the strict
    // unsafe-* family fires on every fixture interaction and buys nothing here.
    files: ['site/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },

  prettier,
);
