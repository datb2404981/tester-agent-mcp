---
name: qa-security-review
description: Kiểm thử bảo mật ứng dụng web trên môi trường QA được phép qua browser và bằng chứng quan sát được.
---

# Kiểm thử bảo mật theo hành vi người dùng

Nguồn: Tester Agent MCP. Áp dụng cho mọi website đã đăng ký trong Tester Agent.

1. Xác minh website local/QA có quyền kiểm thử, tài khoản thử nghiệm và phạm vi chức năng. Chỉ bật `allowWrites=true` khi dữ liệu thử được phép thay đổi. Thêm `allowedOrigins` nếu ứng dụng dùng API ở origin khác. Không tự quét IP, dò endpoint, brute-force, khai thác lỗ hổng hoặc gửi payload gây hại.
2. Dùng `tester_browser_start`, `tester_browser_inspect` và `tester_browser_see` để đọc trạng thái thực tế. Với mỗi kịch bản bảo mật đơn lẻ, gọi `tester_browser_case` `phase=start`, `category=security`, `kind=check`, đặt expected rõ ràng. Với kiểm tra phân quyền hoặc phiên đăng nhập nhiều bước, dùng `kind=flow`, khai báo 2–12 bước, gọi `tester_browser_step` start/finish cho từng bước với assertion tương ứng. Không dùng phản hồi HTTP của bước trước để xác nhận bước sau.
3. Kiểm tra đăng nhập sai bằng thông tin giả để đánh giá thông báo lỗi, không thử nhiều mật khẩu. Đăng nhập đúng bằng tài khoản QA nếu đã được cấp. Xác minh màn hình sau đăng nhập bằng `tester_browser_assert`.
4. Kiểm tra quyền truy cập bằng hai tài khoản QA có vai trò khác nhau nếu có. Thử truy cập trang chức năng qua điều hướng UI khi chưa đăng nhập hoặc sau đăng xuất. Dùng assertion trên URL, thông báo hay thành phần cụ thể để xác nhận bị từ chối hoặc chuyển tới trang đăng nhập. Nếu có request API, dùng `type=responseStatus`, `method`, `path`, `expected` để xác nhận HTTP 401/403 trong chính test case. Kết hợp trạng thái giao diện và dữ liệu để xác minh quyền thật sự bị từ chối, không coi status đơn lẻ là đủ.
5. Kiểm tra input và thông báo lỗi với dữ liệu thử vô hại. Quan sát khả năng hiển thị các giá trị như văn bản thuần, không tự suy diễn lỗi XSS từ một chuỗi ký tự và không gửi chuỗi khai thác.
6. Gọi `tester_browser_security_audit` sau khi mở từng trang đại diện. Audit chỉ quan sát HTTPS, cookie và header. Dấu hiệu thiếu cấu hình là `REVIEW_REQUIRED`, không tự suy ra đã khai thác được lỗ hổng hay hệ thống an toàn tuyệt đối.
7. Kết thúc từng case bằng `tester_browser_case` `phase=finish`. Chỉ ghi PASS cho luồng khi đủ tất cả các bước với assertion phù hợp với expected, kể cả kiểm tra trạng thái sau đăng xuất/đổi vai trò. Ghi BLOCKED khi thiếu tài khoản, tiêu chí mong đợi hoặc bằng chứng. Không đưa token, password, cookie hay thông tin cá nhân vào `name`, `expected`, `description` hoặc báo cáo.
8. Dùng `tester_browser_finish` để lưu báo cáo. Trình bày riêng kết quả chức năng (`functionalOutcome`), dấu hiệu bảo mật (`securityOutcome`) và các vấn đề giao diện (`visualOutcome`).

Phạm vi là kiểm thử bảo mật có giới hạn dựa trên browser và cấu hình quan sát được. Chuyển các dấu hiệu cần đánh giá chuyên sâu cho nhóm phụ trách bảo mật.
