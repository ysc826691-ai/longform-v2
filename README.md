# longform-v2 — 롱폼 자동화 시스템

AI가 주제만 입력하면 대본 → 이미지 → TTS 음성 → MP4 영상까지 자동으로 만들어주는 로컬 실행 시스템입니다.

---

## 다른 PC(노트북)에서 처음 설치하는 방법

### 1단계 — 파일 받기

**방법 A: GitHub에서 클론 (권장)**
```
git clone https://github.com/ysc826691-ai/longform-v2.git
cd longform-v2
```

**방법 B: ZIP 다운로드**
- GitHub 페이지에서 `Code → Download ZIP` 후 압축 해제

### 2단계 — 설치

`install.bat` 더블클릭 → Node.js 자동 설치 + 패키지 설치

### 3단계 — 실행

`시작.bat` 더블클릭 → 브라우저 자동 열림 (`http://localhost:5500`)

---

## YouTube 업로드 기능 설정 (선택)

YouTube 업로드는 Google OAuth 인증 파일이 필요합니다.

1. [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 선택
2. API 및 서비스 → 사용자 인증 정보 → OAuth 2.0 클라이언트 ID
3. JSON 다운로드 후 파일명을 `client_secret.json`으로 변경
4. `longform-v2` 폴더 안에 붙여넣기

> YouTube 업로드를 사용하지 않으면 이 파일 없어도 됩니다.

---

## 전체 기능 사용 설명서

`사용설명서.md` 파일 참조
