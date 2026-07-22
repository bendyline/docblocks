export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [2, 'always', 1024],
    'subject-case': [0],
  },
};
