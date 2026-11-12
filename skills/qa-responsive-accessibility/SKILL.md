---
name: qa-responsive-accessibility
description: Khảo sát responsive, kiểm tra biểu mẫu, tương tác bàn phím và dấu hiệu lỗi trợ năng.
---

# Skill responsive và accessibility

Nguồn: Tester Agent MCP.

1. Với mọi dự án, chạy `tester_test_web` `mode=scan` để kiểm tra mobile 390px, tràn ngang, pageerror và HTTP 5xx.
2. Dựa trên yêu cầu sản phẩm để chọn kiểm tra responsive hoặc bàn phím, tập trung một màn hình mỗi lượt.
3. Trong phiên `tester_browser_start` trên môi trường QA được phép, kiểm tra tên truy cập được của control, label, thứ tự tab, trạng thái focus, thông báo lỗi, menu và vùng có thể cuộn.
4. Báo cáo theo viewport và tên trang. Với vấn đề layout, ghi rõ bước và chiều rộng. Với accessibility, mô tả thao tác bàn phím và cây ngữ nghĩa quan sát được.
5. Kiểm tra báo cáo và chỉ xác nhận PASS với kịch bản đã thực thi. Kiểm thử tự động ở hai kích thước không chứng minh tuân thủ WCAG đầy đủ.
6. Với model nhìn ảnh, gọi `tester_browser_start` rồi `tester_browser_see` tại desktop. Dùng `tester_browser_resize` chuyển sang mobile trong cùng phiên và `tester_browser_see` lần nữa. Gọi `tester_browser_layout_audit` để đo tràn ngang và kiểm chứng bằng `tester_browser_assert` với `type=noHorizontalOverflow` trong test case. So sánh cùng màn hình, trạng thái và nội dung để tránh nhận xét dựa trên ảnh ở các trang khác nhau.
7. Gọi `tester_browser_accessibility_audit` ở những màn hình đại diện để phát hiện dấu hiệu input thiếu nhãn, button/link thiếu accessible name, ảnh thiếu alt và heading nhảy cấp. Kết hợp cây accessibility với thao tác thực tế như Tab, Enter, Escape, focus, thông báo validation. Audit DOM chỉ là bằng chứng một phần, không chứng minh đạt chuẩn WCAG.
8. Tách lỗi khách quan (tràn ngang, chữ bị cắt, thành phần chồng lấn, điều khiển không dùng được) khỏi nhận xét thẩm mỹ (màu sắc, phân cấp, spacing, typography). Với vấn đề có bằng chứng, dùng `tester_browser_visual_finding` và khai báo `observed`, `expected`, `reproductionSteps`, `suggestion` cùng mức độ. Nhận xét thẩm mỹ hoặc dấu hiệu accessibility chưa xác minh thuộc `REVIEW_REQUIRED`.

Không tự sửa giao diện khi yêu cầu chỉ là kiểm thử. Khi có lỗi, đề xuất thay đổi tối thiểu theo design system đang dùng.
