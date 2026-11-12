---
name: qa-test-triage
description: Phân tích báo cáo kiểm thử, tái hiện lỗi và phân loại đúng frontend, backend, test automation hoặc môi trường.
---

# Skill phân tích và phân loại lỗi QA

Nguồn: Tester Agent MCP.

1. Với đa dự án, dùng `tester_project_artifacts` và `tester_project_read_artifact` kèm `project`.
2. Đối chiếu thời điểm chạy, môi trường, dữ liệu QA, trạng thái PASS/FAIL/BLOCKED. Không gộp kết quả từ các lần chạy khác nhau.
3. Với lỗi UI, xem tương tác, locator, trạng thái SPA, request API và DOM mới nhất. Với lỗi nghiệp vụ, kiểm tra trạng thái API/DB và bất biến số lượng.
4. Chỉ đánh dấu defect đã tái hiện nếu có bước tái hiện và expected/actual cụ thể. Test runner sai locator hoặc không làm mới dữ liệu được phân loại test automation.
5. Báo cáo lỗi gồm tiêu đề, mức độ, môi trường, tiền điều kiện, các bước, expected, actual, bằng chứng, trạng thái xác minh.
6. Sửa lỗi trong phạm vi tối thiểu, chạy bài test liên quan và hồi quy nếu cần.
7. Báo cáo browser AI có `functionalOutcome`, `securityOutcome`, `visualOutcome`, `accessibilityOutcome` và danh sách `cases[].steps[]` với assertion theo từng checkpoint. Giữ các nhóm này tách riêng. Xác minh các bước có bằng chứng đúng expected, ưu tiên `FAIL` trước `BLOCKED`, không nâng luồng thiếu checkpoint thành `PASS`. `OBSERVED` là tín hiệu cấu hình/DOM đã quan sát, không xác nhận an toàn hay tuân thủ WCAG. Header thiếu, lỗi trợ năng nghi vấn hoặc đề xuất thẩm mỹ được đánh dấu `REVIEW_REQUIRED` tới khi đối chiếu đủ ngữ cảnh.

Không dùng mã thoát của tiến trình thay cho bằng chứng trong báo cáo. Không in thông tin đăng nhập thử nghiệm hoặc secret.
