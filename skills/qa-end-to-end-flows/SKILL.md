---
name: qa-end-to-end-flows
description: Thiết kế và kiểm chứng luồng người dùng từ đăng nhập tới hoàn tất nghiệp vụ của mọi website trên môi trường QA.
---

# Skill kiểm thử luồng người dùng đa dự án

Nguồn: Tester Agent MCP.

1. Đăng ký website bằng `tester_register_project`. Xác định URL QA, quyền ghi dữ liệu, tài khoản thử nghiệm và tiêu chí hoàn thành của nghiệp vụ. Giữ thông tin đăng nhập ngoài báo cáo và prompt AI.
2. Chạy `tester_test_web` `mode=scan` cả desktop và mobile để thấy trang, navigation, JavaScript và HTTP 5xx. Chỉ kết luận những kiểm tra đã quan sát được.
3. Với model có thị giác và QA `allowWrites=true`, mở `tester_browser_start` theo URL dự án, rồi dùng `tester_browser_see` cùng `tester_browser_inspect` để quan sát trước khi ra quyết định. Thực hiện `tester_browser_action` từng bước và luôn quan sát lại sau các chuyển trạng thái chính.
4. Từ UI và yêu cầu, chọn đường đi quan trọng nhất của sản phẩm. Ví dụ thường gặp là đăng nhập, tìm sách/sản phẩm, xem chi tiết, tạo yêu cầu, theo dõi trạng thái, xử lý yêu cầu từ vai trò quản trị và kiểm tra kết quả cuối. Không tự áp đặt các chức năng này lên website không hỗ trợ.
5. Với một kiểm tra đơn lẻ, mở `tester_browser_case` bằng `phase=start`, `kind=check` và kiểm chứng kết quả thật bằng `tester_browser_assert`. Với luồng nghiệp vụ E2E, dùng `kind=flow` và **khai báo trước 2–12 bước** có `id`, `description`, `expected` riêng. Phải xác định kết quả cuối của nghiệp vụ từ yêu cầu hoặc UI thực tế trước khi chạy.
6. Trong `kind=flow`, với **từng bước theo đúng thứ tự**: gọi `tester_browser_step` `phase=start` với `id`, thực hiện `tester_browser_action`, quan sát lại bằng `tester_browser_see` hoặc `tester_browser_inspect`, dùng `tester_browser_assert` để kiểm chứng đúng `expected` của bước, rồi gọi `tester_browser_step` `phase=finish`. Có thể dùng `type=responseStatus` với `method`, `path`, `expected` (mã HTTP) cho phản hồi phát sinh trong chính bước đó. Mã HTTP hoặc click thành công chưa đủ thay thế bằng chứng UI/nghiệp vụ.
7. Khi nghiệp vụ có nhiều vai trò, xác minh kết quả qua UI của cả hai vai trò. Chẳng hạn, kiểm tra người dùng tạo yêu cầu, người quản lý duyệt đúng yêu cầu, rồi người dùng thấy trạng thái mới. Có thể đăng xuất/đăng nhập lại trong cùng browser bằng tài khoản QA. Kiểm tra dữ liệu sau làm mới trang và các trạng thái âm tính/biên. Chỉ thực hiện thao tác ghi trong phạm vi QA đã được cho phép.
8. Kết thúc **mọi bước** trước khi gọi `tester_browser_case` `phase=finish`, rồi dùng `tester_browser_finish` xuất báo cáo. Nếu bất kỳ bước nào thiếu assertion hoặc chưa hoàn tất, báo `BLOCKED`; nếu thao tác không thực thi được, báo `BLOCKED`; nếu assertion thất bại, báo `FAIL`. Chỉ coi toàn bộ luồng `PASS` khi mọi checkpoint có bằng chứng tương ứng với expected. Dùng `tester_browser_visual_finding` ghi lỗi UI gặp trong luồng. Kịch bản ổn định có thể chuyển thành regression sau khi đối chiếu yêu cầu.

Không dùng tài khoản hay dữ liệu production. Không tự xóa, reset hoặc phá hủy tài nguyên ngoài phạm vi QA đã được người dùng cho phép.
