---
name: qa-tester-exploration
description: Khám phá ứng dụng từ giao diện đang mở, chọn ca kiểm thử và ghi lại bằng chứng.
---

# Khám phá website

Nguồn: Tester Agent MCP.

1. Đăng ký URL của ứng dụng local hoặc môi trường QA được phép. Giữ `allowWrites=false` nếu chỉ quan sát; chỉ bật khi người dùng đã cho phép thao tác trên dữ liệu thử.
2. Dùng `tester_test_web` để thấy các trang liên kết nội bộ và lỗi quan sát được. Sau đó mở `tester_browser_start` và dùng `tester_browser_see` hoặc `tester_browser_inspect` để tìm các chức năng có thật trên trang.
3. Chọn vài mục tiêu có giá trị: luồng chính, trường hợp dữ liệu trống hoặc không hợp lệ, lỗi hiển thị trên mobile. Khai báo expected trước khi thao tác.
4. Chọn mỗi bước từ giao diện hiện tại, bấm qua `tester_browser_action`, quan sát lại và xác minh bằng `tester_browser_assert`. Nếu có nhiều bước phụ thuộc nhau, dùng `tester_browser_case` `kind=flow`.
5. Gọi `tester_browser_finish`. Gửi báo cáo Markdown cho dev và lưu danh sách checkpoint đã xác minh làm đầu vào cho kiểm thử hồi quy. Ghi rõ phần chưa kiểm tra.
