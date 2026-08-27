# Platform Workspace

## 역할

Git worktree처럼 개발 workspace를 실제 파일 시스템에 준비하는 로우레벨 어댑터다.

## 책임

- 현재 Git 저장소와 worktree 상태 조회
- branch 이름 검증
- 새 worktree 생성 또는 동일 worktree의 안전한 재사용
- Git 명령 오류를 사용자에게 설명할 수 있는 메시지로 변환

## 주요 진입점

- `git-worktree.ts`: `git worktree` 명령을 shell 없이 실행하는 어댑터

## 외부 의존성

- `child_process`
- Git CLI
- 파일 시스템

## 주의사항

이 모듈은 Logical Network나 Compose 상태를 변경하지 않는다. 여러 자원을 묶는 정책은
`src/extension`의 onboarding orchestration이 담당한다.
